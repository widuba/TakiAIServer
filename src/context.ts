import { TIME_ZONE } from "./ai.js";
import type { ConversationState, DeviceLocation, DeviceWeather, TranscriptTurn } from "./types.js";
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
  userProfile?: UserPersona,
  voiceMode?: boolean,
  deviceId?: string,
  deviceWeather?: DeviceWeather
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
      // Bound individual turns so pasted documents cannot crowd every useful
      // recent exchange out of the planner prompt.
      const rawText = String(m?.text || "").trim();
      const text = rawText.length > 4000 ? `${rawText.slice(0, 4000)}...` : rawText;
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

  const maxTurns = voiceMode ? 40 : 64;
  const maxChars = voiceMode ? 14000 : 28000;
  const recent: TranscriptTurn[] = [];
  let usedChars = 0;
  for (let i = transcript.length - 1; i >= 0 && recent.length < maxTurns; i -= 1) {
    const turn = transcript[i];
    const cost = turn.text.length + 16;
    if (recent.length >= 6 && usedChars + cost > maxChars) break;
    recent.unshift(turn);
    usedChars += cost;
  }

  const lines = recent.map((t, index) =>
    `Turn ${index + 1} ${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`
  );

  const fullTranscriptText = lines.join("\n").trim();
  const eventTranscriptText = recent
    .filter((turn) => !isCalendarConfirmationLine(`${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`))
    .map((turn, index) => `Turn ${index + 1} ${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n")
    .trim();

  const lastUser = [...recent].reverse().find((turn) => turn.role === "user")?.text || "";
  const lastAssistant = [...recent].reverse().find((turn) => turn.role === "assistant")?.text || "";
  const recentUsers = recent.filter((turn) => turn.role === "user");
  const previousUser = recentUsers.length > 1 ? recentUsers[recentUsers.length - 2].text : "";
  const conversationFocusText = [
    previousUser ? `Previous user request: ${previousUser}` : "",
    lastUser ? `Most recent user request: ${lastUser}` : "",
    lastAssistant ? `Most recent assistant response: ${lastAssistant}` : ""
  ].filter(Boolean).join("\n");

  const correctionsText = structured && Array.isArray(structured.corrections)
    ? structured.corrections.slice(-12).map((item: any, index: number) => {
        const wrong = String(item?.misunderstoodAnswer || "").trim().slice(0, 800);
        const correction = String(item?.userCorrection || "").trim().slice(0, 800);
        return correction ? `Correction ${index + 1}: Assistant misunderstood: ${wrong}\nUser clarified: ${correction}` : "";
      }).filter(Boolean).join("\n")
    : "";

  const decoded = decodeSavedMemory(structured);

  return {
    message,
    transcript: recent,
    eventTranscriptText,
    fullTranscriptText,
    conversationFocusText,
    correctionsText,
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
    deviceWeather,
    styleProfiles: parseIncomingStyleProfiles(styleProfiles),
    userProfile: userProfile || {},
    voiceMode: !!voiceMode,
    deviceId: deviceId ? deviceId.trim() : ""
  };
}
