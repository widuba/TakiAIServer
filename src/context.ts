import { TIME_ZONE } from "./ai.js";
import type { ConversationState, DeviceLocation, TranscriptTurn } from "./types.js";
import { decodeSavedMemory, isCalendarConfirmationLine } from "./memory.js";
import { parseIncomingStyleProfiles } from "./messageStyle.js";
import type { IncomingStyleProfile } from "./messageStyle.js";
import type { UserPersona } from "./persona.js";

// Guard against a malformed/unknown timezone string from the client.
function isValidTimeZone(tz?: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ============================================================================
 * Step 1+2 of the pipeline: normalize the request and build conversational
 * state. The CURRENT chat transcript is the main source of truth; decoded
 * saved memory is fallback only.
 * ==========================================================================*/

export function buildConversationState(
  message: string,
  context: string,
  deviceLocation?: DeviceLocation,
  timeZone?: string,
  styleProfiles?: IncomingStyleProfile[],
  userProfile?: UserPersona
): ConversationState {
  let structured: any = null;
  try {
    structured = context ? JSON.parse(context) : null;
  } catch {
    structured = null;
  }

  // Transcript is scoped to the active chat (the frontend sends only the
  // active chat's messages in chatMessages).
  const transcript: TranscriptTurn[] = [];
  if (structured && Array.isArray(structured.chatMessages)) {
    for (const m of structured.chatMessages) {
      const role: "user" | "assistant" = m?.role === "assistant" ? "assistant" : "user";
      const text = String(m?.text || "").trim();
      if (text) transcript.push({ role, text });
    }
  }

  // Drop a trailing duplicate of the current message (the frontend includes
  // the just-sent user turn in chatMessages).
  if (
    transcript.length > 0 &&
    transcript[transcript.length - 1].role === "user" &&
    transcript[transcript.length - 1].text.trim() === message.trim()
  ) {
    transcript.pop();
  }

  const recent = transcript.slice(-40);
  const lines = recent.map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`);

  const fullTranscriptText = lines.join("\n").trim();
  const eventTranscriptText = lines
    .filter((line) => !isCalendarConfirmationLine(line))
    .join("\n")
    .trim();

  const decoded = decodeSavedMemory(structured);

  return {
    message,
    transcript: recent,
    eventTranscriptText,
    fullTranscriptText,
    nowIso: new Date().toISOString(),
    // Prefer the user's device timezone so "Thursday at 4" lands on the user's
    // calendar, not the server's. Fall back to the server default.
    timeZone: isValidTimeZone(timeZone) ? (timeZone as string) : TIME_ZONE,
    priorEvent: decoded.priorEvent,
    priorContact: decoded.priorContact,
    priorPlace: decoded.priorPlace,
    pendingClarification: decoded.pendingClarification,
    priorMemory: decoded.memory,
    deviceLocation,
    styleProfiles: parseIncomingStyleProfiles(styleProfiles),
    userProfile: userProfile || {}
  };
}
