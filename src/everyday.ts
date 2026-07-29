import type { AssistantAction } from "./types.js";
import { blankAction } from "./types.js";
import { isoFromYmdTime, resolveRelativeYmd, resolveTimeFromMessage } from "./util.js";

export type EverydayRoute = {
  action: AssistantAction;
  spokenText: string;
  lastIntent: string;
};

type EverydayContext = {
  timeZone: string;
  previousAnswer?: string | null;
};

function cleanValue(value: string): string {
  return value
    .trim()
    .replace(/^["“”']+|["“”'?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanReminderQuery(value: string): string {
  return cleanValue(value)
    .replace(/^(?:the|my|a|an)\s+/i, "")
    .replace(/^(?:reminder|task)\s+(?:to|about|for)?\s*/i, "")
    .replace(/\s+(?:reminder|task)$/i, "")
    .trim();
}

function cleanContactQuery(value: string): string {
  return cleanValue(value)
    .replace(/^(?:the|my|a|an)\s+/i, "")
    .replace(/^(?:contact|contact card)\s+(?:for|named)?\s*/i, "")
    .replace(/(?:'s|’s)\s*$/i, "")
    .trim();
}

function referencedText(value: string, previousAnswer?: string | null): string {
  const clean = cleanValue(value);
  if (/^(?:this|that|it|your (?:last|previous) (?:answer|response|message)|the (?:last|previous) (?:answer|response|message))$/i.test(clean)) {
    return String(previousAnswer || "").trim();
  }
  return clean;
}

function reminderUpdate(query: string, changes: Partial<AssistantAction>, spokenText: string): EverydayRoute {
  return {
    action: { ...blankAction("reminder_update"), reminderQuery: cleanReminderQuery(query), ...changes },
    spokenText,
    lastIntent: "reminder_update"
  };
}

/** Fast, deterministic routing for common device utilities. */
export function routeEverydayAction(message: string, context: EverydayContext): EverydayRoute | null {
  const text = message.trim();
  if (!text) return null;

  if (/\b(?:battery|charge)\s+(?:level|percentage|percent|status)\b|\bhow much (?:battery|charge)(?: do i have| is left)?\b|\bis my (?:iphone|phone) charging\b/i.test(text)) {
    return { action: blankAction("device_status"), spokenText: "I'll check your iPhone.", lastIntent: "device_status" };
  }

  const flashlight = text.match(/\b(?:turn|switch|set)\s+(?:my\s+|the\s+|iphone\s+|phone\s+)?(?:flashlight|torch)\s+(on|off)\b|\b(?:flashlight|torch)\s+(on|off)\b/i);
  if (flashlight) {
    const value = (flashlight[1] || flashlight[2]).toLowerCase();
    const action = blankAction("flashlight_control");
    action.deviceAction = value;
    return { action, spokenText: `Turning the flashlight ${value}.`, lastIntent: "flashlight_control" };
  }

  const exportMatch = text.match(/^(?:export|save|download|create)\s+(.+?)\s+(?:as|to)\s+(?:a\s+)?(?:plain\s+)?(?:text|txt)\s+file(?:\s+(?:called|named)\s+(.+?))?[?.!]*$/i);
  if (exportMatch) {
    const action = blankAction("file_export");
    action.body = referencedText(exportMatch[1], context.previousAnswer);
    action.title = cleanValue(exportMatch[2] || "Taki Export");
    return { action, spokenText: "Creating the text file.", lastIntent: "file_export" };
  }

  const copyMatch = text.match(/^copy\s+(.+?)\s+(?:to|onto)\s+(?:my\s+|the\s+)?clipboard[?.!]*$/i);
  if (copyMatch) {
    const action = blankAction("clipboard_copy");
    action.body = referencedText(copyMatch[1], context.previousAnswer);
    return { action, spokenText: "Copying that to your clipboard.", lastIntent: "clipboard_copy" };
  }

  const reminderReschedule = text.match(/^(?:reschedule|move|postpone|change the time of)\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(?:to\s+)?(.+?)\s+(?:to|for|until)\s+(.+?)[?.!]*$/i);
  if (reminderReschedule) {
    const ymd = resolveRelativeYmd(reminderReschedule[2], context.timeZone) || resolveRelativeYmd(text, context.timeZone);
    const time = resolveTimeFromMessage(reminderReschedule[2]) || resolveTimeFromMessage(text);
    const dueDate = ymd ? isoFromYmdTime(ymd, time?.hour ?? 9, time?.minute ?? 0, context.timeZone) : null;
    return reminderUpdate(reminderReschedule[1], { dueDate }, "I'll reschedule that reminder.");
  }

  const reminderRename = text.match(/^(?:rename|retitle)\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(.+?)\s+to\s+(.+?)[?.!]*$/i);
  if (reminderRename) {
    return reminderUpdate(reminderRename[1], { title: cleanValue(reminderRename[2]) }, "I'll rename that reminder.");
  }

  const reminderNote = text.match(/^add\s+(?:the\s+)?note\s+(.+?)\s+to\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(.+?)[?.!]*$/i);
  if (reminderNote) {
    return reminderUpdate(reminderNote[2], { notes: cleanValue(reminderNote[1]) }, "I'll update that reminder.");
  }

  const reminderComplete =
    text.match(/^(?:complete|finish|check off)\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(?:to\s+)?(.+?)[?.!]*$/i) ||
    text.match(/^(?:mark|set)\s+(?:the\s+|my\s+)?(.+?)\s+(?:reminder|task)?\s*(?:as\s+)?(?:done|complete|completed)[?.!]*$/i);
  if (reminderComplete) {
    return reminderUpdate(reminderComplete[1], { reminderCompleted: true }, "I'll mark that reminder complete.");
  }

  const reminderReopen = text.match(/^(?:reopen|uncomplete)\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(.+?)[?.!]*$/i);
  if (reminderReopen) {
    return reminderUpdate(reminderReopen[1], { reminderCompleted: false }, "I'll reopen that reminder.");
  }

  const reminderDelete = text.match(/^(?:delete|remove|cancel)\s+(?:the\s+|my\s+)?(?:reminder|task)?\s*(?:to\s+)?(.+?)(?:\s+(?:reminder|task))?[?.!]*$/i);
  if (reminderDelete && /\b(?:reminder|task)\b/i.test(text)) {
    const action = blankAction("reminder_delete");
    action.reminderQuery = cleanReminderQuery(reminderDelete[1]);
    return { action, spokenText: "I'll delete that reminder.", lastIntent: "reminder_delete" };
  }

  const contactDelete = text.match(/^(?:delete|remove)\s+(?:the\s+)?(?:contact|contact card)\s+(?:for\s+)?(.+?)[?.!]*$|^(?:delete|remove)\s+(.+?)\s+from\s+(?:my\s+)?contacts[?.!]*$/i);
  if (contactDelete) {
    const action = blankAction("contact_delete");
    action.contactQuery = cleanContactQuery(contactDelete[1] || contactDelete[2]);
    return { action, spokenText: "I'll remove that contact.", lastIntent: "contact_delete" };
  }

  const contactPhone = text.match(/^(?:update|change|set)\s+(.+?)(?:'s|’s)?\s+(?:contact\s+)?(?:phone number|phone|number)\s+(?:to\s+)?(.+?)[?.!]*$/i);
  if (contactPhone) {
    const action = blankAction("contact_update");
    action.contactQuery = cleanContactQuery(contactPhone[1]);
    action.recipientPhone = cleanValue(contactPhone[2]);
    return { action, spokenText: "I'll update that phone number.", lastIntent: "contact_update" };
  }

  const contactEmail = text.match(/^(?:update|change|set)\s+(.+?)(?:'s|’s)?\s+(?:contact\s+)?(?:email address|email)\s+(?:to\s+)?([^\s]+@[^\s]+)[?.!]*$/i);
  if (contactEmail) {
    const action = blankAction("contact_update");
    action.contactQuery = cleanContactQuery(contactEmail[1]);
    action.emailAddress = cleanValue(contactEmail[2]);
    return { action, spokenText: "I'll update that email address.", lastIntent: "contact_update" };
  }

  const contactRename = text.match(/^(?:rename|change the name of)\s+(?:the\s+)?contact\s+(.+?)\s+to\s+(.+?)[?.!]*$/i);
  if (contactRename) {
    const action = blankAction("contact_update");
    action.contactQuery = cleanContactQuery(contactRename[1]);
    action.recipientName = cleanValue(contactRename[2]);
    return { action, spokenText: "I'll rename that contact.", lastIntent: "contact_update" };
  }

  const contactDetail = text.match(/^(?:what(?:'s| is)|show me|give me|find)\s+(.+?)(?:'s|’s)\s+(phone number|phone|email address|email)[?.!]*$/i);
  const contactLookup = text.match(/^(?:look up|find|show me)\s+(?:the\s+)?contact(?: card)?\s+(?:for\s+)?(.+?)[?.!]*$/i);
  if (contactDetail || contactLookup) {
    const action = blankAction("contact_search");
    action.contactQuery = cleanContactQuery(contactDetail?.[1] || contactLookup?.[1] || "");
    action.contactField = contactDetail ? (/email/i.test(contactDetail[2]) ? "email" : "phone") : "all";
    return { action, spokenText: "I'll check Contacts.", lastIntent: "contact_search" };
  }

  return null;
}
