import type {
  AssistantAction,
  ConversationState,
  PendingClarification,
  PlannerIntent,
  PlannerModelOutput
} from "./types.js";
import { isExplicitAllAlertCancellation } from "./tools.js";

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
  "reminder_update",
  "reminder_delete",
  "calendar_search",
  "open_app",
  "maps_search",
  "maps_directions",
  "calendar_directions",
  "contact_create",
  "contact_search",
  "contact_update",
  "contact_delete",
  "health_query",
  "music_control",
  "home_control",
  "photos_show",
  "personal_search",
  "share_content",
  "clipboard_copy",
  "file_export",
  "flashlight_control",
  "device_status",
  "calendar_forward",
  "live_activity",
  "day_plan",
  "service_handoff",
  "list_action",
  "expense_action",
  "habit_action",
  "automation_create",
  "scheduled_message",
  "cooking_mode",
  "cooking_schedule",
  "alert_create",
  "alert_cancel",
  "recurring_reminder",
  "memory_save",
  "action_history",
  "undo_last"
]);

export type PlannerAuditIssue = {
  question: string;
  pending: PendingClarification;
  reason: string;
};

function clean(value: unknown): string {
  return expandCommonContractions(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SHORT_NON_ENTITY_WORDS = new Set([
  "a", "an", "am", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
  "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we"
]);

function groundingToken(value: string): string {
  // `clean` intentionally keeps periods for email addresses and decimal
  // values. For phrase grounding, a terminal period is punctuation rather than
  // part of the entity ("late." should match "late").
  return value.replace(/^\.+|\.+$/g, "");
}

function userCorrectionEvidence(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => /^\s*user\s+clarified\s*:/i.test(line))
    .join("\n");
}

function evidenceSegments(state: ConversationState): string[] {
  const transcript = Array.isArray(state.transcript) ? state.transcript : [];
  return [
    state.message,
    // Only user turns are grounding evidence. Assistant text can be a
    // hallucinated suggestion and must never make an invented recipient or
    // destination executable on the next turn.
    ...transcript.filter((turn) => turn.role === "user").map((turn) => turn.text),
    // The correction itself is user-authored; the earlier misunderstood answer
    // is intentionally excluded from executable grounding.
    userCorrectionEvidence(state.correctionsText),
    state.priorContact?.name,
    state.priorContact?.phone,
    state.priorContact?.email,
    state.priorEvent?.title,
    state.priorEvent?.startDate,
    state.priorEvent?.endDate,
    state.priorEvent?.location,
    state.priorPlace?.label,
    state.priorPlace?.query,
    state.priorPlace?.address,
    state.userProfile?.about,
    // Model-derived memory is not grounding evidence. It can help the planner
    // maintain continuity, but a hallucinated prior topic must never become an
    // executable entity after a vague follow-up such as "yes".
  ].filter(Boolean).map((value) => clean(value));
}

function normalizedEvidence(state: ConversationState): string {
  return evidenceSegments(state).join("\n");
}

function evidenceText(state: ConversationState): string {
  return normalizedEvidence(state);
}

function expandCommonContractions(value: unknown): string {
  return String(value || "")
    .replace(/\bI'll\b/gi, "I will")
    .replace(/\bI'd\b/gi, "I would")
    .replace(/\bI'm\b/gi, "I am")
    .replace(/\bI've\b/gi, "I have")
    .replace(/\bcan't\b/gi, "cannot")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bdon't\b/gi, "do not")
    .replace(/\bdoesn't\b/gi, "does not")
    .replace(/\bisn't\b/gi, "is not")
    .replace(/\baren't\b/gi, "are not")
    .replace(/\bthat's\b/gi, "that is")
    .replace(/\bit's\b/gi, "it is");
}

function bodyEvidenceSegments(state: ConversationState): string[] {
  return evidenceSegments(state).map((segment) => clean(expandCommonContractions(segment)));
}

function isBodyGrounded(value: unknown, state: ConversationState): boolean {
  const wanted = clean(expandCommonContractions(value));
  if (!wanted) return false;
  const tokens = wanted.split(" ").map(groundingToken).filter((token) => token.length >= 3 || (token.length >= 2 && !SHORT_NON_ENTITY_WORDS.has(token)));
  if (!tokens.length) return false;
  return bodyEvidenceSegments(state).some((segment) => {
    const segmentTokens = new Set(segment.split(" ").map(groundingToken).filter(Boolean));
    const overlap = tokens.filter((token) => segmentTokens.has(token)).length;
    // Exact wording is preferred, but allow a light contraction/punctuation
    // rewrite as long as the body still shares most of its meaningful words
    // with one user-authored turn. A one-word body ("Thanks") must match.
    return overlap === tokens.length || (tokens.length >= 2 && overlap >= Math.max(2, Math.ceil(tokens.length * 0.6)));
  });
}

function isGrounded(value: unknown, state: ConversationState): boolean {
  const wanted = clean(value);
  if (!wanted) return true;
  const evidence = evidenceText(state);
  const segments = evidenceSegments(state);

  // Phone numbers are often formatted differently by the model and the
  // speech recognizer. Compare their digits as a contiguous value rather than
  // requiring punctuation or spaces to survive normalization.
  const wantedDigits = wanted.replace(/\D/g, "");
  if (wantedDigits.length >= 7) {
    return segments.some((segment) => segment.replace(/\D/g, "").includes(wantedDigits));
  }

  // Allow harmless formatting differences while still requiring the meaningful
  // words to have appeared as complete tokens. Substring matching made an
  // invented recipient such as "Ann" appear grounded by "announcement".
  const tokens = wanted.split(" ").map(groundingToken).filter((token) => token.length >= 3 || (token.length >= 2 && !SHORT_NON_ENTITY_WORDS.has(token)));
  if (!tokens.length) return false;
  const evidenceTokens = new Set(evidence.split(" ").map(groundingToken).filter(Boolean));
  // For a multi-word entity, require the normalized words to occur together in
  // the same order. Otherwise a proposal such as "Chris Mom" could be built
  // by combining two unrelated names from different turns.
  if (tokens.length > 1) {
    const phrase = tokens.join(" ");
    return segments.some((segment) => {
      if (segment.includes(phrase)) return true;
      const segmentTokens = new Set(segment.split(" ").map(groundingToken).filter(Boolean));
      return tokens.every((token) => segmentTokens.has(token));
    });
  }
  return tokens.every((token) => evidenceTokens.has(token));
}

function hasTemporalEvidence(state: ConversationState): boolean {
  const evidence = normalizedEvidence(state);
  return /\b(?:today|tomorrow|tonight|yesterday|this\s+(?:morning|afternoon|evening|week|month|year)|next\s+(?:week|month|year)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\b20\d{2}\b)\b/i.test(evidence);
}

function hasExplicitCalendarTimeEvidence(state: ConversationState): boolean {
  const evidence = normalizedEvidence(state);
  const hasNaturalTime = /\b(?:noon|midnight|all[- ]day)\b|\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\bat\s+\d{1,2}(?::\d{2})?(?:\b|\s)/i.test(evidence);
  const savedEventTimes = [state.priorEvent?.startDate, state.priorEvent?.endDate]
    .filter(Boolean)
    .some((value) => /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/i.test(String(value)));
  return hasNaturalTime || savedEventTimes;
}

function missingActionDetail(plan: PlannerModelOutput): { question: string; reason: string } | null {
  const action = plan.action || {};
  switch (plan.intent) {
    case "compose_message":
      if (!(action.recipientName || action.contactQuery || action.recipientPhone)) return { question: "Who should I text?", reason: "message recipient was missing" };
      if (!action.body && !plan.researchQuery) return { question: "What should the message say?", reason: "message body was missing" };
      return null;
    case "compose_email":
      if (!(action.recipientName || action.contactQuery || action.emailAddress)) return { question: "Who should I email?", reason: "email recipient was missing" };
      if (!action.body && !plan.researchQuery) return { question: "What should the email say?", reason: "email body was missing" };
      return null;
    case "call_phone":
      return action.recipientName || action.contactQuery || action.recipientPhone ? null : { question: "Who should I call?", reason: "call recipient was missing" };
    case "calendar_create":
      if (!action.title) return { question: "What should I call the calendar event?", reason: "calendar title was missing" };
      if (!action.startDate || !action.endDate) return { question: "What date and time should I use?", reason: "calendar date/time was missing" };
      return null;
    case "calendar_update":
    case "calendar_delete":
      return action.calendarQuery || action.title ? null : { question: questionFor(plan.intent, action), reason: "calendar event was missing" };
    case "reminder_create":
      return action.title ? null : { question: "What should I remind you about?", reason: "reminder title was missing" };
    case "reminder_update":
      if (!action.reminderQuery) return { question: "Which reminder should I update?", reason: "reminder target was missing" };
      if (action.reminderCompleted == null && !action.dueDate && !action.title && !action.notes) return { question: "What should I change about that reminder?", reason: "reminder change was missing" };
      return null;
    case "reminder_delete":
      return action.reminderQuery ? null : { question: "Which reminder should I delete?", reason: "reminder target was missing" };
    case "maps_search":
      return action.mapsQuery ? null : { question: "What place should I search for?", reason: "map query was missing" };
    case "maps_directions":
      return action.mapsDestination ? null : { question: "Where do you want directions to?", reason: "destination was missing" };
    case "open_app":
      return action.appName ? null : { question: "Which app should I open?", reason: "app name was missing" };
    case "home_control":
      return action.homeAction ? null : { question: "Which home device should I control, and what should I do?", reason: "home command was missing" };
    case "music_control":
      return action.musicAction ? null : { question: "What should I play or control?", reason: "music command was missing" };
    case "health_query":
      if (action.type === "health_log") return action.healthLogMetric ? null : { question: "What health entry should I log?", reason: "health log metric was missing" };
      if (action.type === "health_trend") return action.metric ? null : { question: "Which health measurement do you mean?", reason: "health trend metric was missing" };
      return action.metric ? null : { question: "Which health measurement do you mean?", reason: "health metric was missing" };
    case "contact_create":
      return action.recipientName && (action.recipientPhone || action.emailAddress) ? null : { question: "Who's the contact, and what's their number or email?", reason: "contact details were missing" };
    case "contact_search":
      return action.contactQuery ? null : { question: "Which contact should I look up?", reason: "contact query was missing" };
    case "contact_update":
      if (!action.contactQuery) return { question: "Which contact should I update?", reason: "contact target was missing" };
      return action.recipientName || action.recipientPhone || action.emailAddress ? null : { question: "What should I change about that contact?", reason: "contact change was missing" };
    case "contact_delete":
      return action.contactQuery ? null : { question: "Which contact should I delete?", reason: "contact target was missing" };
    case "clipboard_copy":
      return action.body ? null : { question: "What text should I copy?", reason: "clipboard text was missing" };
    case "file_export":
      return action.body ? null : { question: "What text should I put in the file?", reason: "file text was missing" };
    case "flashlight_control":
      return action.deviceAction === "on" || action.deviceAction === "off" ? null : { question: "Should I turn the flashlight on or off?", reason: "flashlight state was missing" };
    case "live_activity":
      return action.trackKind
        ? action.trackQuery ? null : { question: "What should I track?", reason: "live tracker query was missing" }
        : action.liveActivityKind === "commute" ? null : { question: "What should I track or use for the live commute?", reason: "live activity target was missing" };
    case "day_plan":
      return Array.isArray(action.planItems) && action.planItems.length ? null : { question: "I couldn't build that day plan.", reason: "day plan items were missing" };
    case "service_handoff":
      return action.service && action.serviceKind ? null : { question: "Which supported service should I open?", reason: "service handoff details were missing" };
    case "list_action":
      if (!action.listOp) return { question: "What should I do with the list?", reason: "list operation was missing" };
      if ((action.listOp === "add" || action.listOp === "remove") && !action.listItem) return { question: action.listOp === "add" ? "What should I add to the list?" : "What should I remove from the list?", reason: "list item was missing" };
      return null;
    case "expense_action":
      if (!action.expenseOp) return { question: "Should I log an expense or total your spending?", reason: "expense operation was missing" };
      if (action.expenseOp === "log" && (!Number.isFinite(action.expenseAmount) || Number(action.expenseAmount) <= 0)) return { question: "How much did you spend?", reason: "expense amount was missing" };
      return null;
    case "habit_action":
      if (!action.habitOp) return { question: "What should I do with that habit?", reason: "habit operation was missing" };
      return action.habitOp === "list" || !!action.habitName ? null : { question: "Which habit do you mean?", reason: "habit name was missing" };
    case "automation_create":
      if (!action.automationPlace || !action.automationAction) return { question: "Where should that automation run, and what should it do?", reason: "automation details were missing" };
      return null;
    case "scheduled_message":
      if (!(action.recipientName || action.contactQuery || action.recipientPhone)) return { question: "Who should I schedule that text for?", reason: "scheduled message recipient was missing" };
      if (!action.body) return { question: "What should the scheduled text say?", reason: "scheduled message body was missing" };
      if (!action.dueDate) return { question: "When should I schedule that text?", reason: "scheduled message time was missing" };
      return null;
    case "cooking_mode":
      return action.recipe?.title && action.recipe.steps?.length ? null : { question: "I couldn't prepare that recipe reliably.", reason: "recipe was missing" };
    case "cooking_schedule":
      if (!action.recipe?.title || !action.recipe.steps?.length) return { question: "I couldn't prepare that recipe reliably.", reason: "recipe was missing" };
      return action.dueDate ? null : { question: "When should I schedule that cooking reminder?", reason: "cooking reminder time was missing" };
    case "alert_create":
      if (!action.alertKind || !action.alertQuery) return { question: "What should I watch for in the alert?", reason: "alert details were missing" };
      return action.alertKind === "price" && (!Number.isFinite(action.alertTarget) || !action.alertDirection)
        ? { question: "What price and direction should trigger the alert?", reason: "price alert target was missing" }
        : null;
    case "recurring_reminder":
      return action.title && action.recurKind ? null : { question: "What should I remind you about, and how often?", reason: "recurring reminder details were missing" };
    case "personal_search":
      return action.personalSearchQuery ? null : { question: "What should I search your connected sources for?", reason: "personal search query was missing" };
    case "share_content":
      return action.shareKind === "calendar" || action.shareKind === "calendar_list" || !!action.shareText
        ? null : { question: "What would you like me to share?", reason: "share content was missing" };
    case "alert_cancel":
    case "memory_save":
    case "action_history":
    case "undo_last":
      return null;
    default:
      return null;
  }
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
  if (a.type) {
    const actualType = String(a.type);
    const expectedType = plan.intent === "calendar_create_from_context"
      ? "calendar_create"
      : plan.intent === "health_query" && (actualType === "health_log" || actualType === "health_trend")
        ? actualType
        : plan.intent === "photos_show" && actualType === "photos_search"
          ? actualType
          : String(plan.intent);
    if (actualType !== expectedType) {
      return makeIssue(state, plan, "action type does not match intent", "I need to confirm what action you want me to take.");
    }
  }
  const missing = missingActionDetail(plan);
  if (missing) return makeIssue(state, plan, missing.reason, missing.question);
  if (plan.intent === "alert_cancel" && !a.alertKind && !a.alertQuery && !isExplicitAllAlertCancellation(state.message)) {
    return makeIssue(state, plan, "alert cancellation scope was ambiguous", "Which alert should I cancel?");
  }
  const recipients = [a.recipientName, a.contactQuery, a.recipientPhone, a.emailAddress, plan.contact?.name, plan.contact?.phone, plan.contact?.email]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (recipients.some((recipient) => !isGrounded(recipient, state))) {
    return makeIssue(state, plan, "recipient was not grounded in user context", "Who do you mean?");
  }

  // The stricter body/date grounding is part of Brain v2's staged contract.
  // Keep legacy planner behavior unchanged until v2 is deliberately enabled
  // for a canary or full rollout.
  const strictBrain = plan.brainVersion === "v2" || plan.brainVersion === "v3";
  if (strictBrain && (plan.intent === "compose_message" || plan.intent === "compose_email") && a.body && !plan.researchQuery && !isBodyGrounded(a.body, state)) {
    return makeIssue(
      state,
      plan,
      "message body was not grounded in user context",
      plan.intent === "compose_email" ? "What should the email say?" : "What should the message say?"
    );
  }

  if (strictBrain && plan.intent === "calendar_create") {
    if (a.title && !isGrounded(a.title, state)) {
      return makeIssue(state, plan, "calendar title was not grounded in user context", "What should I call the calendar event?");
    }
    if (!hasTemporalEvidence(state)) {
      return makeIssue(state, plan, "calendar date/time was missing", "What date and time should I use?");
    }
    if (!hasExplicitCalendarTimeEvidence(state)) {
      return makeIssue(state, plan, "calendar time was missing", "What time should I use for that event?");
    }
  }
  if (strictBrain && plan.intent === "reminder_create" && a.title && !isGrounded(a.title, state)) {
    return makeIssue(state, plan, "reminder title was not grounded in user context", "What should I remind you about?");
  }
  if (strictBrain && plan.intent === "reminder_create" && a.dueDate && !hasTemporalEvidence(state)) {
    return makeIssue(state, plan, "reminder date/time was not grounded", "When should I remind you?");
  }
  if (strictBrain && plan.intent === "reminder_update" && a.dueDate && !hasTemporalEvidence(state)) {
    return makeIssue(state, plan, "reminder date/time was not grounded", "When should I reschedule that reminder?");
  }
  if (strictBrain && plan.intent === "calendar_update" && (a.startDate || a.endDate) && !hasTemporalEvidence(state)) {
    return makeIssue(state, plan, "calendar date/time was not grounded", "What date and time should I use for that event?");
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
  if (plan.intent === "personal_search") {
    checks.push({ value: a.personalSearchQuery, question: "What should I search your connected sources for?", reason: "personal search query was not grounded" });
  }
  if (plan.intent === "share_content" && a.shareKind !== "calendar" && a.shareKind !== "calendar_list") {
    checks.push({ value: a.shareText, question: "What would you like me to share?", reason: "share content was not grounded" });
  }
  if (plan.intent === "live_activity") {
    if (a.trackQuery) checks.push({ value: a.trackQuery, question: "What should I track?", reason: "live tracker query was not grounded" });
    if (a.calendarQuery || a.title) checks.push({ value: a.calendarQuery || a.title, question: "Which event should I use for the live commute?", reason: "live activity event was not grounded" });
  }
  if (plan.intent === "day_plan") {
    // A day plan is generated content, but the model must not smuggle an
    // unrelated destination or recipient into the proposed schedule. The
    // structural validator checks the times; this audit keeps the plan from
    // becoming a covert messaging or external-service action.
    if (a.planItems?.some((item) => /(?:text|email|call|send|book|order|pay)\b/i.test(`${item.type} ${item.title}`))) {
      return makeIssue(state, plan, "day plan contained an unrelated external action", "What should I include in the day plan?");
    }
  }
  if (plan.intent === "service_handoff") {
    checks.push({ value: a.serviceQuery, question: "Which place or item should I use?", reason: "service query was not grounded" });
    checks.push({ value: a.serviceDestination, question: "Where should the ride go?", reason: "service destination was not grounded" });
  }
  if (plan.intent === "list_action" && (a.listOp === "add" || a.listOp === "remove")) {
    checks.push({ value: a.listItem, question: a.listOp === "add" ? "What should I add to the list?" : "What should I remove from the list?", reason: "list item was not grounded" });
  }
  if (plan.intent === "expense_action") {
    checks.push({ value: a.expenseCategory, question: "Which spending category do you mean?", reason: "expense category was not grounded" });
    if (a.expenseAmount != null) checks.push({ value: String(a.expenseAmount), question: "How much did you spend?", reason: "expense amount was not grounded" });
  }
  if (plan.intent === "habit_action" && a.habitName) {
    checks.push({ value: a.habitName, question: "Which habit do you mean?", reason: "habit name was not grounded" });
  }
  if (plan.intent === "automation_create") {
    checks.push({ value: a.automationPlace, question: "Where should that automation run?", reason: "automation place was not grounded" });
    checks.push({ value: a.automationAction, question: "What should the automation do?", reason: "automation action was not grounded" });
  }
  if (plan.intent === "scheduled_message") {
    checks.push({ value: a.body, question: "What should the scheduled text say?", reason: "scheduled message body was not grounded" });
    if (a.dueDate && !hasTemporalEvidence(state)) return makeIssue(state, plan, "scheduled message time was not grounded", "When should I schedule that text?");
  }
  if (plan.intent === "recurring_reminder" && a.title) {
    checks.push({ value: a.title, question: "What should I remind you about?", reason: "recurring reminder title was not grounded" });
  }
  if (plan.intent === "alert_create") {
    checks.push({ value: a.alertQuery, question: "What should I watch for in the alert?", reason: "alert query was not grounded" });
    if (a.alertTarget != null) checks.push({ value: String(a.alertTarget), question: "What price should trigger the alert?", reason: "alert target was not grounded" });
  }
  if (plan.intent === "memory_save" && a.memoryOperation !== "clear") {
    checks.push({ value: a.memoryFact, question: "What would you like me to remember?", reason: "memory fact was not grounded" });
  }

  for (const check of checks) {
    if (check.value && !isGrounded(check.value, state)) {
      return makeIssue(state, plan, check.reason, check.question);
    }
  }

  return null;
}
