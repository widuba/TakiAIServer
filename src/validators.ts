import type {
  AssistantAction,
  AssistantMemory,
  AssistantPlan,
  AssistantResponse,
  ConversationState,
  EventMemory
} from "./types.js";
import { blankAction } from "./types.js";
import {
  cleanCalendarEventTitle,
  eventMemoryToFollowUp,
  looksLikeCommandGarbageTitle
} from "./memory.js";
import {
  addMinutesToIsoLocal,
  addDaysToYmd,
  extractCalendarLocation,
  extractCalendarTitle,
  formatEventDateTime,
  isoFromYmdTime,
  resolveRelativeYmd,
  resolveTimeFromMessage
} from "./util.js";

/* ============================================================================
 * Step 4 of the pipeline: deterministic validation + the response finalizer.
 *
 * These functions are the guard rails around the LLM plan. They:
 *  - verify required fields exist for each action,
 *  - build a clean calendar_create action (with timezone-correct dates),
 *  - synchronize spokenText with the action,
 *  - forbid spoken promises that have no matching action,
 *  - assemble the structured wire memory.
 * ==========================================================================*/

export function normalizeAction(action: Partial<AssistantAction> | null): AssistantAction | null {
  if (!action?.type) return null;
  if (action.type === "answer_only" || action.type === "weather_answer") return null;
  return { ...blankAction(action.type), ...action };
}

// Returns a clarifying question string if the action is missing required info,
// otherwise null.
export function validateAction(action: AssistantAction | null): string | null {
  if (!action) return null;

  if (action.type === "calendar_create") {
    if (!action.title || !action.startDate || !action.endDate) {
      return "I need a title, date, and time before I can add that to your calendar.";
    }
    if (looksLikeCommandGarbageTitle(action.title)) {
      return "I did not understand the event title well enough. What should I call the calendar event?";
    }
    const start = Date.parse(action.startDate);
    const end = Date.parse(action.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return "What exact date and time should I use for that event?";
    }
  }

  if (action.type === "calendar_update") {
    if (!action.calendarQuery || !action.calendarQuery.trim()) return "Which calendar event should I update?";
    const hasChange = !!(action.location || action.notes || action.startDate || action.endDate || action.title);
    if (!hasChange) return "What should I change about that event?";
  }

  if (action.type === "calendar_delete") {
    if (!action.calendarQuery || !action.calendarQuery.trim()) return "Which calendar event should I remove?";
  }

  if (action.type === "compose_message") {
    if (!action.recipientPhone && !action.contactQuery && !action.recipientName) return "Who should I send that message to?";
    if (!action.body || !action.body.trim()) return "What do you want the message to say?";
  }

  if (action.type === "compose_email") {
    if (!action.emailAddress && !action.contactQuery && !action.recipientName) return "Who should I email?";
    if (!action.body || !action.body.trim()) return "What do you want the email to say?";
  }

  if (action.type === "calendar_forward") {
    const email = action.shareKind?.startsWith("email");
    if (email && !action.emailAddress && !action.contactQuery && !action.recipientName) return "Who should I email that calendar information to?";
    if (!email && !action.recipientPhone && !action.contactQuery && !action.recipientName) return "Who should I text that calendar information to?";
  }

  if (action.type === "call_phone") {
    if (!action.recipientPhone && !action.contactQuery && !action.recipientName) return "Who should I call?";
  }

  if (action.type === "reminder_create") {
    if (!action.title || !action.title.trim()) return "What should I remind you about?";
    if (action.dueDate && !Number.isFinite(Date.parse(action.dueDate))) return "When should I remind you?";
  }

  if (action.type === "maps_search" && !action.mapsQuery) return "What should I search for in Maps?";
  if (action.type === "maps_directions" && !action.mapsDestination) return "Where do you want directions to?";
  if (action.type === "open_app" && !action.appUrl && !action.appName) return "Which app should I open?";

  if (action.type === "alarm_set" || action.type === "timer_set") {
    if (!action.startDate || !Number.isFinite(Date.parse(action.startDate))) {
      return action.type === "alarm_set" ? "What time should I set the alarm for?" : "How long should the timer run for?";
    }
  }

  if (action.type === "health_query") {
    const allowed = new Set([
      "steps", "distance", "cycling", "energy", "restingenergy", "dietaryenergy", "exercise", "stand",
      "flights", "water", "heartrate", "restingheartrate", "walkingheartrate", "hrv", "vo2max", "weight",
      "bmi", "bodyfat", "leanmass", "height", "oxygen", "respiratory", "temperature", "glucose",
      "bloodpressure", "sleep"
    ]);
    if (!action.metric || !allowed.has(action.metric.toLowerCase())) return "Which health measurement should I check?";
  }

  if (action.type === "music_control") {
    const allowed = new Set(["play", "pause", "resume", "next", "previous"]);
    if (!action.musicAction || !allowed.has(action.musicAction)) return "What should I play or control?";
  }

  if (action.type === "home_control") {
    const allowed = new Set(["lightsOn", "lightsOff", "lock", "unlock", "thermostat"]);
    if (!action.homeAction || !allowed.has(action.homeAction)) return "What should I control in your home?";
    if (action.homeAction === "thermostat" && !Number.isFinite(action.homeValue)) return "What temperature should I set?";
  }

  if (action.type === "photos_search" && !action.photoQuery?.trim()) return "What should I search for in your photos?";

  if (action.type === "contact_create") {
    if (!action.recipientName?.trim()) return "What is the contact's name?";
    if (!action.recipientPhone?.trim() && !action.emailAddress?.trim()) return "What is their phone number or email?";
  }

  if (action.type === "memory_save" && !action.memoryFact?.trim()) return "What would you like me to remember?";

  if (action.type === "share_content") {
    if (action.shareKind === "calendar" || action.shareKind === "calendar_list") return null;
    if (!action.shareText?.trim()) return "What would you like me to share?";
  }

  return null;
}

function actionOpensAppOrSystemSheet(action: AssistantAction | null): boolean {
  return !!action && new Set<AssistantAction["type"]>([
    "compose_message",
    "compose_email",
    "call_phone",
    "open_app",
    "maps_search",
    "maps_directions",
    "email_connect",
    "service_handoff",
    "share_content",
    "calendar_forward"
  ]).has(action.type);
}

// Build a calendar_create action from a partial action + the raw message.
// When the message itself contains an explicit date AND time, trust the
// deterministic local (timezone-correct) resolution over the model's ISO,
// which often emits a UTC "Z" time that shifts the event hours off.
// Returns null if it cannot be made calendar-ready.
export function buildCalendarCreateAction(
  message: string,
  a: Partial<AssistantAction> | null,
  fallbackTitle?: string | null,
  timeZone?: string
): AssistantAction | null {
  let startDate = String(a?.startDate || "").trim();
  let endDate = String(a?.endDate || "").trim();

  const localYmd = resolveRelativeYmd(message, timeZone);
  const localTime = resolveTimeFromMessage(message);
  if (localYmd && localTime) {
    startDate = isoFromYmdTime(localYmd, localTime.hour, localTime.minute, timeZone);
    endDate = "";
  }

  if (!startDate || !Number.isFinite(Date.parse(startDate))) {
    if (localYmd && localTime) {
      startDate = isoFromYmdTime(localYmd, localTime.hour, localTime.minute, timeZone);
    } else {
      startDate = "";
    }
  }

  if (startDate && (!endDate || !Number.isFinite(Date.parse(endDate)))) {
    endDate = addMinutesToIsoLocal(startDate, 60);
  }

  let title = cleanCalendarEventTitle(String(a?.title || "").trim());
  if (!title && fallbackTitle) title = cleanCalendarEventTitle(fallbackTitle);
  if (!title) title = extractCalendarTitle(message);

  if (!title || !startDate || !endDate || looksLikeCommandGarbageTitle(title)) return null;

  return {
    ...blankAction("calendar_create"),
    title,
    startDate,
    endDate,
    location: a?.location ? String(a.location) : extractCalendarLocation(message) || null,
    notes: a?.notes ? String(a.notes) : null
  };
}

function localEventParts(iso: string, timeZone: string): { ymd: string; hour: number; minute: number } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
    const year = value("year"), month = value("month"), day = value("day");
    const hour = Number(value("hour")), minute = Number(value("minute"));
    if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { ymd: `${year}-${month}-${day}`, hour, minute };
  } catch {
    return null;
  }
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
};

// Resolve calendar edits against the event itself. This avoids moving a future
// Thursday event backward to "this Friday" when the user says "move it to
// Friday", and preserves the original date for a time-only change.
export function resolveCalendarUpdateDates(
  message: string,
  priorEvent: EventMemory | null,
  timeZone: string,
  modelStartDate: string | null,
  modelEndDate: string | null
): { startDate: string | null; endDate: string | null } {
  if (!priorEvent) return { startDate: modelStartDate, endDate: modelEndDate };
  const original = localEventParts(priorEvent.startDate, timeZone);
  if (!original) return { startDate: modelStartDate, endDate: modelEndDate };

  const weekdayMatch = message.toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  const hasOtherDate = /\b(today|tomorrow|tonight|yesterday|\d{1,2}[/-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/i.test(message);
  let targetYmd: string | null = null;

  if (weekdayMatch && !hasOtherDate) {
    const originalDay = new Date(`${original.ymd}T12:00:00Z`).getUTCDay();
    let delta = (WEEKDAYS[weekdayMatch[1]] - originalDay + 7) % 7;
    if (/\bnext\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(message) && delta === 0) delta = 7;
    targetYmd = addDaysToYmd(original.ymd, delta);
  } else {
    targetYmd = resolveRelativeYmd(message, timeZone);
  }

  const requestedTime = resolveTimeFromMessage(message);
  const changesTime = !!requestedTime;
  const changesDate = !!targetYmd;
  if (!changesDate && !changesTime) return { startDate: modelStartDate, endDate: modelEndDate };

  const ymd = targetYmd || original.ymd;
  const hour = requestedTime?.hour ?? original.hour;
  const minute = requestedTime?.minute ?? original.minute;
  const startDate = isoFromYmdTime(ymd, hour, minute, timeZone);

  const oldStart = Date.parse(priorEvent.startDate);
  const oldEnd = Date.parse(priorEvent.endDate);
  const durationMinutes = Number.isFinite(oldStart) && Number.isFinite(oldEnd) && oldEnd > oldStart
    ? Math.max(1, Math.round((oldEnd - oldStart) / 60000))
    : 60;
  return { startDate, endDate: addMinutesToIsoLocal(startDate, durationMinutes) };
}

/* ---- Spoken/action synchronization -------------------------------------- */

// Remove spoken promises that have no matching action. The assistant must
// never say "I'll add/text/call/email/remind ..." without a real action.
function stripFalsePromises(spokenText: string): string {
  let text = spokenText
    .replace(/\bI(?:'|’)?ll add[^.?!]*\.?/gi, "")
    .replace(/\bI will add[^.?!]*\.?/gi, "")
    .replace(/\bI(?:'|’)?ll (?:text|message|email|call|remind|search|open|draft|send)[^.?!]*\.?/gi, "")
    .replace(/\bI will (?:text|message|email|call|remind|search|open|draft|send)[^.?!]*\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/* ============================================================================
 * finalizeResponse — turn a plan into the wire response + enforce invariants.
 * ==========================================================================*/

export function finalizeResponse(plan: AssistantPlan, state: ConversationState): AssistantResponse {
  // The confidence meter is only for objective informational answers. It is
  // emitted ONLY when the answer path attached a real confidence (or the answer
  // is grounded by live sources) — never for actions, clarifying questions, or
  // subjective/creative/chit-chat replies (those carry no confidence, so no meter).
  const hasAction = !!(plan.action || (plan.actions && plan.actions.length));
  const rawConfidence = hasAction ? undefined : (plan.confidence ?? (plan.sources?.length ? 9 : undefined));
  const confidence = typeof rawConfidence === "number"
    ? Math.max(1, Math.min(10, Math.round(rawConfidence)))
    : undefined;
  // ---- Multi-action plans (e.g. "add the next 3 games") ------------------
  if (plan.actions && plan.actions.length > 1) {
    const good = plan.actions
      .map(normalizeAction)
      .filter((a): a is AssistantAction => !!a)
      .filter((a) => !validateAction(a));

    if (good.length) {
      const lastEvt = plan.memoryPatch.lastMentionedEvent || null;
      const spoken = good.some(actionOpensAppOrSystemSheet)
        ? "Done."
        : plan.spokenText || `Added ${good.length} events to your calendar.`;
      const memory: AssistantMemory = {
        ...state.priorMemory,
        lastTopic: state.message,
        lastAnswer: spoken,
        lastIntent: plan.memoryPatch.lastIntent ?? state.priorMemory.lastIntent ?? null,
        lastMentionedEvent: lastEvt || state.priorMemory.lastMentionedEvent || null,
        lastEvent: lastEvt || state.priorMemory.lastEvent || null,
        lastMentionedContact: state.priorMemory.lastMentionedContact ?? null,
        lastMentionedPlace: state.priorMemory.lastMentionedPlace ?? null,
        pendingClarification: null
      };
      return {
        spokenText: spoken,
        action: good[0],
        actions: good,
        sources: plan.sources,
        confidence,
        comparison: plan.comparison,
        memory,
        followUpEvent: eventMemoryToFollowUp(lastEvt),
        messageAnalysis: good.some((action) => action.type === "compose_message")
          ? plan.messageAnalysis ?? null
          : null,
        debug: plan.debug
      };
    }
    // If none survived validation, fall through to the single-action path.
  }

  let spokenText = plan.spokenText || "";
  let action = plan.action;
  const memoryPatch = { ...plan.memoryPatch };

  // Safety net: drop an action that is missing required fields.
  const issue = validateAction(action);
  if (action && issue) {
    spokenText = issue;
    action = null;
    memoryPatch.lastMentionedEvent = undefined;
  }

  if (action && action.type === "calendar_create") {
    // INVARIANT: spokenText describes the exact calendar_create, and the
    // remembered event equals exactly the action being created.
    const title = cleanCalendarEventTitle(String(action.title || "").trim());
    action.title = title;
    const whenText = formatEventDateTime(String(action.startDate || ""), state.timeZone);
    spokenText = whenText ? `Added ${title} for ${whenText}.` : `Added ${title} to your calendar.`;
    memoryPatch.lastMentionedEvent = {
      title,
      startDate: String(action.startDate || ""),
      endDate: String(action.endDate || ""),
      location: action.location || undefined,
      notes: action.notes || undefined,
      source: memoryPatch.lastMentionedEvent?.source || "calendar_create",
      confidence: 1
    };
  } else if (!action) {
    // INVARIANT: no action -> no action promises.
    const cleaned = stripFalsePromises(spokenText);
    if (cleaned !== spokenText) spokenText = cleaned || "Okay.";
  }

  if (actionOpensAppOrSystemSheet(action)) spokenText = "Done.";

  if (!spokenText.trim()) spokenText = action ? "Okay." : "Done.";

  // ---- Build structured wire memory --------------------------------------
  const newEvent: EventMemory | null = memoryPatch.lastMentionedEvent || null;
  const lastEvent: EventMemory | null = newEvent || state.priorMemory.lastMentionedEvent || state.priorEvent || null;

  const memory: AssistantMemory = {
    ...state.priorMemory,
    lastTopic: state.message,
    lastAnswer: spokenText,
    lastIntent: memoryPatch.lastIntent ?? state.priorMemory.lastIntent ?? null,
    lastMentionedEvent: lastEvent,
    lastEvent, // legacy mirror
    lastMentionedContact: memoryPatch.lastMentionedContact ?? state.priorMemory.lastMentionedContact ?? null,
    lastMentionedPlace: memoryPatch.lastMentionedPlace ?? state.priorMemory.lastMentionedPlace ?? null,
    // pendingClarification: undefined in patch means "leave as-is" only when we
    // did not touch it; the planner sets null to clear and an object to set.
    pendingClarification:
      memoryPatch.pendingClarification === undefined
        ? null
        : memoryPatch.pendingClarification
  };

  if (action?.type === "compose_message") {
    memory.lastMessageDraft = {
      recipientName: action.recipientName,
      contactQuery: action.contactQuery,
      body: action.body
    };
  }
  if (action?.type === "compose_email") {
    memory.lastEmailDraft = {
      recipientName: action.recipientName,
      contactQuery: action.contactQuery,
      emailAddress: action.emailAddress,
      subject: action.emailSubject,
      body: action.body
    };
  }
  if (action?.type === "maps_search") {
    memory.lastLocation = { label: action.mapsQuery, query: action.mapsQuery };
  }
  if (action?.type === "maps_directions") {
    memory.lastLocation = { label: action.mapsDestination, query: action.mapsDestination };
  }

  // Only surface the style analysis when a compose_message action actually
  // survived validation — never for a dropped/cleared action.
  const finalAction = normalizeAction(action);
  const messageAnalysis =
    finalAction?.type === "compose_message" ? plan.messageAnalysis ?? null : null;

  return {
    spokenText,
    action: finalAction,
    sources: plan.sources,
    confidence,
    comparison: plan.comparison,
    memory,
    followUpEvent: eventMemoryToFollowUp(lastEvent),
    messageAnalysis,
    debug: plan.debug
  };
}
