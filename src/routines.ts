import { parseHomeCommand, parseMusicCommand } from "./tools.js";
import { storeGet, storeSet } from "./store.js";

/* ============================================================================
 * Custom home routines — one saved phrase fires several device actions.
 *
 * Built-in "scenes" (goodnight / movie night / leaving / I'm home) live in
 * tools.ts (parseSceneCommand) and are hard-coded. This module adds USER-DEFINED
 * routines: "when I say <name>, <do A, B, C>" is parsed into an ordered list of
 * steps, stored per device (keyed by the 8-digit identity), and recalled by name
 * later. Steps reuse the existing home_control / music_control actions, so the
 * device executes them with no native changes.
 *
 * The server is stateless per request, so routines persist in the durable store
 * (DATABASE_URL); without it they fall back to the file store like everything
 * else.
 * ==========================================================================*/

export type RoutineStep = {
  kind: "home" | "music";
  action: string;
  target?: string;
  value?: number;
  query?: string;
};

export type Routine = { name: string; steps: RoutineStep[] };

// Lowercase, strip surrounding quotes/punctuation, collapse whitespace.
function cleanName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^["'“”]+/, "")
    .replace(/["'“”.?!,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Canonical routine key: cleaned + trailing "routine/scene/mode" words dropped so
// "party mode" saved and "party mode" spoken both reduce to "party". Applied at
// both save and match time so the two always line up.
function canonical(s: string): string {
  return cleanName(s)
    .replace(/\b(routine|scene|mode)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Users often phrase routine steps in the third person ("...it turns off the
// lights and locks the door"). parseHomeCommand/parseMusicCommand expect the
// imperative, so singularize the leading verb before parsing each clause.
function toImperative(clause: string): string {
  return clause.replace(
    /\b(turn|lock|unlock|set|play|dim|shut|switch|start|stop|pause|skip|lower|raise|resume|kill)s\b/gi,
    "$1"
  );
}

// Split a definition's action clause into steps, parsing each with the existing
// home/music detectors. Unrecognized fragments are simply dropped.
function parseSteps(clause: string): RoutineStep[] {
  const parts = clause
    .split(/,|\band then\b|\bthen\b|\band also\b|\band\b|;|\bplus\b/i)
    .map((s) => toImperative(s.trim()))
    .filter(Boolean);
  const steps: RoutineStep[] = [];
  for (const p of parts) {
    const h = parseHomeCommand(p);
    if (h) {
      steps.push({ kind: "home", action: h.action, target: h.target, value: h.value });
      continue;
    }
    const mu = parseMusicCommand(p);
    if (mu) {
      steps.push({ kind: "music", action: mu.action, query: mu.query });
      continue;
    }
  }
  return steps;
}

export function looksLikeRoutineDefinition(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\bwhen i say\b/.test(m) ||
    /\b(create|make|set up|setup|define|add|save)\b[^.]*\broutine\b/.test(m) ||
    /\broutine\b[^.]*\b(called|named)\b/.test(m)
  );
}

// Parse "when I say X, <clause>" (and a few equivalents) into a Routine, else
// null. Returns null when no name or no recognizable steps are found.
export function parseRoutineDefinition(message: string): Routine | null {
  const raw = message.trim();
  let name = "";
  let clause = "";

  // "when I say goodnight, turn off the lights" / "when I say goodnight then ...".
  // A quoted name wins (its quotes mark the boundary); otherwise the name is
  // everything up to the FIRST comma, colon, or "then".
  let mm =
    raw.match(/when i say\s+["“](.+?)["”][,:\s]+(.+)/i) ||
    raw.match(/when i say\s+(.+?)\s*(?:,|:|\s+then\s+)\s*(.+)/i);
  if (mm) {
    name = mm[1];
    clause = mm[2];
  }

  // "create/make/set up a routine (called|named|for) X (that|to|:|-|,) <clause>"
  if (!name) {
    mm = raw.match(
      /routine\s+(?:called|named|for)\s+(.+?)\s*(?:\bthat\b|\bwhich\b|\bto\b|\bwhere\b|:|-|,)\s*(.+)/i
    );
    if (mm) {
      name = mm[1];
      clause = mm[2];
    }
  }

  // "define X as <clause>"
  if (!name) {
    mm = raw.match(/\bdefine\s+(.+?)\s+as\s+(.+)/i);
    if (mm) {
      name = mm[1];
      clause = mm[2];
    }
  }

  if (!name || !clause) return null;
  const nm = canonical(name);
  if (!nm || nm.length > 40) return null;
  const steps = parseSteps(clause);
  if (steps.length === 0) return null;
  return { name: nm, steps };
}

// "list my routines" / "delete the goodnight routine". Kept separate from the
// definition parser and checked first in the planner.
export function parseRoutineManagement(
  message: string
): { op: "list" } | { op: "delete"; name: string } | null {
  const m = message.toLowerCase().trim();
  if (
    /\b(list|show|see|view|what are|what'?s)\b[^.]*\broutines?\b/.test(m) ||
    /^my routines?\??$/.test(m)
  ) {
    return { op: "list" };
  }
  const del =
    m.match(
      /\b(?:delete|remove|forget|clear|get rid of|erase)\b\s+(?:the\s+|my\s+)?["'“]?(.+?)["'”]?\s+routine\b/
    ) ||
    m.match(
      /\b(?:delete|remove|forget|clear|erase)\b\s+(?:the\s+|my\s+)?routine\s+(?:called\s+|named\s+)?["'“]?(.+?)["'”]?\s*$/
    );
  if (del) return { op: "delete", name: del[1] };
  return null;
}

/* ---- Storage ------------------------------------------------------------ */

function key(deviceId: string): string {
  return `routines:${deviceId}`;
}

export async function loadRoutines(deviceId: string): Promise<Routine[]> {
  if (!deviceId) return [];
  const list = await storeGet<Routine[]>(key(deviceId), []);
  return Array.isArray(list) ? list : [];
}

export async function saveRoutine(deviceId: string, routine: Routine): Promise<void> {
  if (!deviceId) return;
  const list = await loadRoutines(deviceId);
  const idx = list.findIndex((r) => r.name === routine.name);
  if (idx >= 0) list[idx] = routine;
  else list.push(routine);
  // Cap so a runaway client can't bloat the store.
  await storeSet(key(deviceId), list.slice(-50));
}

export async function deleteRoutine(deviceId: string, name: string): Promise<boolean> {
  if (!deviceId) return false;
  const list = await loadRoutines(deviceId);
  const target = canonical(name);
  const next = list.filter((r) => r.name !== target);
  if (next.length === list.length) return false;
  await storeSet(key(deviceId), next);
  return true;
}

// Match a spoken command against a saved routine name. Kept strict: the whole
// message (minus a leading run/start verb and trailing routine/scene/mode word)
// must equal a stored name, so a routine only fires when clearly invoked.
export async function matchRoutine(deviceId: string, message: string): Promise<Routine | null> {
  const list = await loadRoutines(deviceId);
  if (!list.length) return null;
  const stripped = cleanName(message)
    .replace(/^(hey\s+)?(taki[,\s]+)?/, "")
    .replace(/^(?:please\s+)?(?:run|start|activate|trigger|execute|begin)\s+/, "")
    .replace(/^(?:the|my)\s+/, "");
  const cand = canonical(stripped);
  const candRaw = canonical(cleanName(message));
  for (const r of list) {
    if (r.name && (r.name === cand || r.name === candRaw)) return r;
  }
  return null;
}

// Human-readable one-liner for a step (used in confirmations + the list view).
export function describeStep(s: RoutineStep): string {
  if (s.kind === "music") {
    switch (s.action) {
      case "pause":
        return "pause the music";
      case "resume":
        return "resume the music";
      case "next":
        return "skip the track";
      case "previous":
        return "go to the previous track";
      case "shuffleon":
        return "shuffle on";
      case "shuffleoff":
        return "shuffle off";
      case "restart":
        return "restart the track";
      default:
        return s.query ? `play ${s.query}` : "control the music";
    }
  }
  switch (s.action) {
    case "lightsOn":
      return s.target ? `turn on the ${s.target} lights` : "turn on the lights";
    case "lightsOff":
      return s.target ? `turn off the ${s.target} lights` : "turn off the lights";
    case "lock":
      return "lock up";
    case "unlock":
      return "unlock the door";
    case "thermostat":
      return `set the thermostat to ${s.value}°`;
    default:
      return s.action;
  }
}

// Cleaned display name, exported so the planner can echo names consistently.
export function displayRoutineName(name: string): string {
  return canonical(name);
}
