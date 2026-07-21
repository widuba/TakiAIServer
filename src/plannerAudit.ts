import type {
  AssistantAction,
  ConversationState,
  PendingClarification,
  PlannerIntent,
  PlannerModelOutput
} from "./types.js";

const EXECUTABLE_MODEL_INTENTS = new Set<PlannerIntent>([
  "compose_message",
  "compose_email",
  "call_phone",
  "calendar_create",
  "calendar_create_from_context",
  "calendar_update",
  "calendar_delete",
  "reminder_create",
  "reminder_search",
  "calendar_search",
  "open_app",
  "maps_search",
  "maps_directions",
  "calendar_directions",
  "contact_create",
  "health_query",
  "music_control",
  "home_control",
  "photos_show",
  "calendar_forward"
]);

export type PlannerAuditIssue = {
  question: string;
  pending: PendingClarification;
  reason: string;
};

function clean(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceText(state: ConversationState): string {
  return clean([
    state.message,
    state.fullTranscriptText,
    state.priorContact?.name,
    state.priorContact?.phone,
    state.priorContact?.email,
    state.priorEvent?.title,
    state.priorEvent?.location,
    state.priorPlace?.label,
    state.priorPlace?.query,
    state.priorPlace?.address,
    state.userProfile?.about
  ].filter(Boolean).join("\n"));
}

function isGrounded(value: unknown, state: ConversationState): boolean {
  const wanted = clean(value);
  if (!wanted) return true;
  const evidence = evidenceText(state);
  if (evidence.includes(wanted)) return true;

  // Allow harmless formatting differences while still requiring the meaningful
  // words to have appeared in the request, conversation, profile, or memory.
  const tokens = wanted.split(" ").filter((token) => token.length >= 3);
  return tokens.length > 0 && tokens.every((token) => evidence.includes(token));
}

function questionFor(intent: PlannerIntent, action: Partial<AssistantAction> | null): string {
  switch (intent) {
    case "compose_message": return "Who should I text, and what should the message say?";
    case "compose_email": return "Who should I email, and what should the email say?";
    case "calendar_forward": return "Which calendar event should I share, and who should receive it?";
    case "call_phone": return "Who should I call?";
    case "calendar_create":
    case "calendar_create_from_context": return "Which event do you mean, and what date and time should I use?";
    case "calendar_update": return "Which calendar event should I update, and what should I change?";
    case "calendar_delete": return "Which calendar event should I remove?";
    case "reminder_create": return "What should I remind you about, and when?";
    case "open_app": return "Which app should I open?";
    case "maps_search": return "What place should I search for?";
    case "maps_directions": return "Where do you want directions to?";
    case "calendar_directions": return "Which calendar event should I use?";
    case "contact_create": return "Who's the contact, and what's their number or email?";
    case "health_query": return "Which health measurement and day do you mean?";
    case "music_control": return "What should I play or control?";
    case "home_control": return "Which home device should I control, and what should I do?";
    default: return action?.type ? "Can you clarify the details for that action?" : "Can you clarify what you want me to do?";
  }
}

function makeIssue(
  state: ConversationState,
  plan: PlannerModelOutput,
  reason: string,
  question = questionFor(plan.intent, plan.action)
): PlannerAuditIssue {
  const pendingIntent = String(plan.action?.type || (plan.intent === "calendar_create_from_context" ? "calendar_create" : plan.intent));
  return {
    question,
    reason,
    pending: {
      intent: pendingIntent,
      missing: plan.missing.length ? plan.missing : ["unambiguous details"],
      draftAction: plan.action || null,
      question,
      createdAt: state.nowIso
    }
  };
}

// Model plans are proposals, never authority. This audit runs before any switch
// branch can turn a proposal into a phone-side action.
export function auditPlannerOutput(plan: PlannerModelOutput, state: ConversationState): PlannerAuditIssue | null {
  if (!EXECUTABLE_MODEL_INTENTS.has(plan.intent)) return null;

  if (!Number.isFinite(plan.confidence) || plan.confidence < 0.68) {
    return makeIssue(state, plan, "low-confidence executable plan");
  }

  const a = plan.action || {};
  const recipient = a.recipientName || a.contactQuery || plan.contact?.name;
  if (recipient && !isGrounded(recipient, state)) {
    return makeIssue(state, plan, "recipient was not grounded in user context", "Who do you mean?");
  }

  const checks: { value: unknown; question: string; reason: string }[] = [];
  if (plan.intent === "calendar_update" || plan.intent === "calendar_delete" || plan.intent === "calendar_search" || plan.intent === "calendar_forward") {
    checks.push({ value: a.calendarQuery || a.title, question: "Which calendar event do you mean?", reason: "calendar subject was not grounded" });
  }
  if (plan.intent === "calendar_create_from_context") {
    checks.push({ value: plan.event?.title, question: "Which event do you want me to add?", reason: "referenced event was not grounded" });
  }
  if (plan.intent === "maps_search") {
    checks.push({ value: a.mapsQuery, question: "What place should I search for?", reason: "map query was not grounded" });
  }
  if (plan.intent === "maps_directions") {
    checks.push({ value: a.mapsDestination, question: "Where do you want directions to?", reason: "destination was not grounded" });
  }
  if (plan.intent === "calendar_directions") {
    checks.push({ value: a.calendarQuery, question: "Which calendar event should I use?", reason: "calendar subject was not grounded" });
  }
  if (plan.intent === "open_app") {
    checks.push({ value: a.appName, question: "Which app should I open?", reason: "app name was not grounded" });
  }
  if (plan.intent === "music_control" && a.musicQuery) {
    checks.push({ value: a.musicQuery, question: "What should I play?", reason: "music choice was not grounded" });
  }
  if (plan.intent === "home_control" && a.homeTarget) {
    checks.push({ value: a.homeTarget, question: "Which room or device do you mean?", reason: "home target was not grounded" });
  }

  for (const check of checks) {
    if (check.value && !isGrounded(check.value, state)) {
      return makeIssue(state, plan, check.reason, check.question);
    }
  }

  return null;
}
