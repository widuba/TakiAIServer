import type {
  AssistantAction,
  AssistantMemory,
  ContactMemory,
  EventMemory,
  PendingClarification,
  PlaceMemory
} from "./types.js";
import { blankAction } from "./types.js";

/* ============================================================================
 * Structured memory helpers.
 *
 * Memory is structured (events / contacts / places / pending clarification),
 * never free text. The current chat transcript always outranks this; saved
 * memory is fallback only and is round-tripped through the frontend's
 * follow-up context.
 * ==========================================================================*/

// Assistant lines that merely CONFIRM a calendar add are NOT real events. We
// must never re-schedule from these on a later "add it" (test case G).
export function isCalendarConfirmationLine(line: string) {
  const lower = line.toLowerCase().trim();
  return (
    /^(assistant:\s*)?(okay,?\s*)?(i['’]?ll|i will)\s+add\b/.test(lower) ||
    /^(assistant:\s*)?added\b/.test(lower) ||
    /\bsuccessfully added\b/.test(lower) ||
    /\bi added\b/.test(lower) ||
    /\bi['’]ve added\b/.test(lower) ||
    /\bto your calendar\b/.test(lower)
  );
}

export function cleanCalendarEventTitle(title: string) {
  return String(title || "")
    .replace(/^added\s+/i, "")
    .replace(/^okay,\s*i(?:'|’)?ll add\s+/i, "")
    .replace(/^i(?:'|’)?ll add\s+/i, "")
    .replace(/\s+to your calendar\.?$/i, "")
    .trim();
}

// A calendar title must be a real event name, never command scaffolding.
export function looksLikeCommandGarbageTitle(title: string) {
  const t = String(title || "").trim();
  return (
    /\b(thanks|thank you|great|please|can you|could you|would you|add it|put it|do it|the game|the event)\b/i.test(t) ||
    /^(add|put|create|schedule|it|that|this|yes|ok|okay)$/i.test(t) ||
    t.length < 2
  );
}

export function isValidEventMemory(ev: any): boolean {
  if (!ev) return false;
  const title = String(ev.title || "").trim();
  const startDate = String(ev.startDate || "").trim();
  const endDate = String(ev.endDate || "").trim();
  if (!title || !startDate || !endDate) return false;
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

export function toEventMemory(ev: any, source: string, confidence: number): EventMemory {
  return {
    title: cleanCalendarEventTitle(ev.title),
    startDate: String(ev.startDate || ""),
    endDate: String(ev.endDate || ""),
    location: ev.location ? String(ev.location) : undefined,
    notes: ev.notes ? String(ev.notes) : undefined,
    source,
    confidence
  };
}

export function eventToCalendarAction(event: EventMemory): AssistantAction {
  return {
    ...blankAction("calendar_create"),
    title: cleanCalendarEventTitle(event.title),
    startDate: event.startDate,
    endDate: event.endDate,
    location: event.location || null,
    notes: event.notes || null
  };
}

export function isValidContact(c: any): boolean {
  if (!c) return false;
  return Boolean(String(c.name || "").trim() || String(c.phone || "").trim() || String(c.email || "").trim());
}

export function isValidPlace(p: any): boolean {
  if (!p) return false;
  return Boolean(String(p.label || "").trim() || String(p.query || "").trim() || String(p.address || "").trim());
}

/* ---- Decode saved memory from the round-tripped follow-up context -------- */

export type DecodedMemory = {
  memory: AssistantMemory;
  priorEvent: EventMemory | null;
  priorContact: ContactMemory | null;
  priorPlace: PlaceMemory | null;
  pendingClarification: PendingClarification | null;
};

// The frontend round-trips saved memory inside `followUpContext` (a stringified
// JSON blob). We decode it here as FALLBACK only.
export function decodeSavedMemory(structured: any): DecodedMemory {
  let memory: AssistantMemory = {};

  const fc = structured?.followUpContext;
  if (typeof fc === "string" && fc.trim()) {
    try {
      const inner = JSON.parse(fc);
      if (inner?.memory && typeof inner.memory === "object") memory = inner.memory;
      // Legacy: followUpEvent stored alongside memory.
      if (!memory.lastMentionedEvent && isValidEventMemory(inner?.followUpEvent)) {
        memory.lastMentionedEvent = toEventMemory(inner.followUpEvent, "saved-memory", 0.5);
      }
    } catch {
      // ignore malformed follow-up context
    }
  } else if (structured?.memory && typeof structured.memory === "object") {
    memory = structured.memory;
  }

  const eventCandidate = memory.lastMentionedEvent || memory.lastEvent;
  const priorEvent = isValidEventMemory(eventCandidate)
    ? toEventMemory(eventCandidate, eventCandidate?.source || "saved-memory", eventCandidate?.confidence ?? 0.5)
    : null;

  const priorContact = isValidContact(memory.lastMentionedContact) ? memory.lastMentionedContact! : null;
  const priorPlace = isValidPlace(memory.lastMentionedPlace) ? memory.lastMentionedPlace! : null;
  const pendingClarification = memory.pendingClarification?.intent ? memory.pendingClarification : null;

  return { memory, priorEvent, priorContact, priorPlace, pendingClarification };
}

/* ---- Build the wire memory after a turn --------------------------------- */

export function eventMemoryToFollowUp(ev: EventMemory | null): EventMemory | null {
  if (!ev) return null;
  return {
    title: ev.title,
    startDate: ev.startDate,
    endDate: ev.endDate,
    location: ev.location,
    notes: ev.notes,
    source: ev.source,
    confidence: ev.confidence
  };
}
