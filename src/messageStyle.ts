/* ============================================================================
 * Per-recipient message-style support (backend half).
 *
 * Privacy model: the LEARNED profiles live on the device (localStorage). The
 * backend is stateless about who you talk to — it only ever receives, for the
 * current request, the small set of style vectors for recipients actually named
 * in the message (see ConversationState.styleProfiles). It never sees a contact
 * list or message history.
 *
 * Responsibilities here:
 *   - shared vector type + clamp,
 *   - turn an incoming vector into short natural-language style hints for the
 *     generation prompt (so the body is written in the user's learned voice),
 *   - estimate the style vector of a generated body (deterministic heuristic, no
 *     extra model call) for the messageAnalysis the frontend learns from,
 *   - match an incoming profile to a resolved recipient name.
 * ==========================================================================*/

export type MessageStyleVector = {
  warmth: number; // -5 cold/blunt, +5 warm/affectionate
  formality: number; // -5 casual, +5 formal
  brevity: number; // -5 detailed, +5 short/concise
  energy: number; // -5 calm/low-key, +5 energetic/excited
  directness: number; // -5 soft/indirect, +5 direct/clear
  humor: number; // -5 serious, +5 playful/funny
  punctuation: number; // -5 minimal punctuation, +5 expressive punctuation/emojis
  polish: number; // -5 raw/natural, +5 polished/edited
};

// The eight axes, in a stable order. Used for iteration/serialization.
export const STYLE_KEYS: (keyof MessageStyleVector)[] = [
  "warmth",
  "formality",
  "brevity",
  "energy",
  "directness",
  "humor",
  "punctuation",
  "polish"
];

export const NEUTRAL_VECTOR: MessageStyleVector = {
  warmth: 0,
  formality: 0,
  brevity: 0,
  energy: 0,
  directness: 0,
  humor: 0,
  punctuation: 0,
  polish: 0
};

const clamp = (n: number) => Math.max(-5, Math.min(5, n));

// Coerce an arbitrary/partial object into a valid, clamped vector.
export function clampStyleVector(v: Partial<MessageStyleVector> | null | undefined): MessageStyleVector {
  const out: MessageStyleVector = { ...NEUTRAL_VECTOR };
  if (!v || typeof v !== "object") return out;
  for (const k of STYLE_KEYS) {
    const raw = (v as any)[k];
    out[k] = Number.isFinite(raw) ? clamp(Number(raw)) : 0;
  }
  return out;
}

// What the frontend sends per relevant recipient.
export type IncomingStyleProfile = {
  recipientKey: string;
  recipientName: string;
  vector: MessageStyleVector;
};

// Returned to the frontend for every compose_message so it can show feedback
// controls and learn from them.
export type MessageAnalysis = {
  recipientKey?: string;
  recipientName?: string;
  generatedBody: string;
  styleVectorUsed: MessageStyleVector; // the profile applied (or zeros)
  estimatedVector: MessageStyleVector; // backend's read of the generated body
  explanation?: string;
};

/* ---- Recipient keying --------------------------------------------------- */

// Stable, privacy-friendly key for a recipient. Prefers an explicit contact id,
// then a normalized name, then phone/email. Mirrors the frontend helper so a
// key produced on either side lines up.
export function normalizeRecipientKey(opts: {
  contactId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}): string {
  if (opts.contactId && opts.contactId.trim()) return `id:${opts.contactId.trim()}`;
  if (opts.name && opts.name.trim()) {
    const norm = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-");
    if (norm) return `name:${norm}`;
  }
  if (opts.phone && opts.phone.trim()) return `phone:${opts.phone.replace(/[^\d+]/g, "")}`;
  if (opts.email && opts.email.trim()) return `email:${opts.email.toLowerCase().trim()}`;
  return "name:unknown";
}

// Find the incoming profile that matches a resolved recipient name. The frontend
// only sends profiles for names that appeared in the message, so this is a tiny
// list; we match on the normalized name key.
export function matchStyleProfile(
  profiles: IncomingStyleProfile[] | undefined,
  recipientName: string | null
): IncomingStyleProfile | null {
  if (!profiles?.length || !recipientName) return null;
  const wanted = normalizeRecipientKey({ name: recipientName });
  // Exact normalized-name match first.
  for (const p of profiles) {
    if (p.recipientKey === wanted) return p;
    if (normalizeRecipientKey({ name: p.recipientName }) === wanted) return p;
  }
  // Loose first-name match ("Chris" vs "Chris Walters").
  const first = recipientName.toLowerCase().trim().split(/\s+/)[0];
  for (const p of profiles) {
    const pFirst = (p.recipientName || "").toLowerCase().trim().split(/\s+/)[0];
    if (first && first === pFirst) return p;
  }
  return null;
}

/* ---- Vector -> prompt hints --------------------------------------------- */

// Translate a learned vector into a few short, natural style directions. Only
// axes that are clearly non-neutral (|value| >= 2) produce a hint, and the
// wording is deliberately soft ("lean", "a little") so the model nudges the
// voice rather than caricaturing it. Returns "" for a neutral profile.
export function styleVectorToPromptHints(v: MessageStyleVector): string {
  const hints: string[] = [];
  // Tiered + concrete so the model commits. An axis registers as soon as it
  // leaves neutral (>=0.5); at >=1.5 it's stated plainly; at >=3 it's "very …"
  // with a concrete instruction so a single strong correction lands hard.
  const add = (
    n: number,
    low: string,
    high: string,
    exLow = "",
    exHigh = ""
  ) => {
    const m = Math.abs(n);
    if (m < 0.5) return;
    const base = n < 0 ? low : high;
    const ex = n < 0 ? exLow : exHigh;
    if (m >= 3) hints.push(`very ${base}${ex ? ` ${ex}` : ""}`);
    else if (m >= 1.5) hints.push(base);
    else hints.push(`a little ${base}`);
  };

  add(v.warmth, "cold and matter-of-fact", "warm and affectionate", "(blunt, no fluff)", "(say it with real feeling)");
  add(v.formality, "casual and relaxed", "polished and formal", "(lowercase, contractions, slang like 'hey'/'yeah')", "(complete sentences, no contractions or slang)");
  add(v.brevity, "detailed and thorough", "short and to the point", "", "(just a few words)");
  add(v.energy, "calm and low-key", "upbeat and energetic", "", "(lots of excitement)");
  add(v.directness, "gentle and indirect", "direct and clear", "", "(blunt, straight to the point)");
  add(v.humor, "sincere and serious", "playful and funny", "", "(joke around, be witty)");
  add(v.punctuation, "minimal punctuation, no emojis", "expressive punctuation", "", "(use exclamation points and an emoji or two)");
  add(v.polish, "raw and unedited like a quick text", "clean and well-edited", "(lowercase and casual is fine)", "");

  return hints.join("; ");
}

/* ---- Heuristic vector estimation ---------------------------------------- */

// Estimate the 8-axis style of a written body WITHOUT another model call. These
// are coarse but consistent signals — enough for the feedback loop to learn a
// direction. Everything is clamped to [-5, 5].
//
// The frontend has a parallel implementation (app/src/messageStyle.ts) used to
// score user-edited messages; keep the two roughly in sync.
export function estimateVectorFromText(text: string): MessageStyleVector {
  const body = String(text || "").trim();
  if (!body) return { ...NEUTRAL_VECTOR };

  return scoreStyleHeuristic(body, clamp);
}

// Shared scoring body so the frontend and backend stay identical. Tuned to give
// each axis a meaningful magnitude (not timid 0/1 readings) so the learning loop
// has real signal to move on. `cl` is the clamp([-5,5]) used by the caller.
const SLANG = /\b(hey|hiya|yo|sup|gonna|wanna|gotta|kinda|dunno|lol|lmao|lmfao|haha+|hehe|omg|btw|idk|tbh|ngl|fr|lmk|imo|cuz|cos|ya|yea|yeah|yep|nah|nope|u|ur|ya'?ll|y'?all|pls|plz|thx|k|kk|cya|ttyl|bro|dude|babe|bae)\b/;
export function scoreStyleHeuristic(body: string, cl: (n: number) => number): MessageStyleVector {
  const lower = body.toLowerCase();
  const words = body.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const exclaims = (body.match(/!/g) || []).length;
  const questions = (body.match(/\?/g) || []).length;
  const ellipses = (body.match(/\.\.\.|…/g) || []).length;
  const emojis = (body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu) || []).length;
  const contractions = (lower.match(/\b\w+'\w+\b/g) || []).length;
  const allLower = body === lower && /[a-z]/.test(body);
  const noEndPunct = !/[.!?]$/.test(body);
  const slangHits = (lower.match(new RegExp(SLANG.source, "g")) || []).length;

  const has = (re: RegExp) => re.test(lower);
  const count = (re: RegExp) => (lower.match(re) || []).length;

  // --- brevity: short = high. ~3 words -> +4, ~9 -> 0, ~18+ -> -4.
  const brevity = cl(Math.round((9 - wordCount) / 1.6));

  // --- warmth: affection/gratitude/pet-names push up; curt/blunt pull down.
  const warmthHits =
    count(/\b(love|luv|miss|proud|sweetheart|honey|babe|bae|dear|darling|hug|hugs|xoxo|thank you|thanks|appreciate|grateful|happy|glad|care|sweet|cutie)\b/g) +
    emojis;
  const warmth = cl(warmthHits * 2 - (has(/\b(no|nope|whatever|fine|stop|don'?t)\b/) ? 1 : 0));

  // --- formality: greetings/sign-offs/please up; slang/lowercase/emoji down.
  let formality = 0;
  if (has(/\b(hello|good (morning|afternoon|evening)|dear|regards|sincerely|please|would you|could you|kindly|thank you|appreciate it)\b/)) formality += 2;
  formality -= slangHits * 2;
  if (contractions > 0) formality -= 1;
  if (emojis > 0) formality -= 1;
  if (allLower) formality -= 1;
  formality = cl(formality);

  // --- energy: exclamations, caps, excited vocab.
  const capsWords = words.filter((w) => w.length >= 3 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  const energy = cl(
    exclaims * 2 +
      capsWords +
      (has(/\b(can'?t wait|so excited|let'?s go|yay+|woohoo|pumped|amazing|awesome|stoked|hyped)\b/) ? 2 : 0) -
      (has(/\b(tired|whenever|no rush|eh|meh|ok|okay)\b/) ? 1 : 0)
  );

  // --- directness: imperatives/short declaratives high; hedging low.
  let directness = 0;
  if (has(/^\s*(can you|could you|would you|please|let me know|just wondering|maybe|if you (want|can)|whenever)\b/)) directness -= 2;
  if (has(/\b(maybe|perhaps|i guess|sort of|kind of|if that'?s ok|no worries|if you get a chance)\b/)) directness -= 1;
  if (wordCount <= 6 && !questions) directness += 2;
  if (has(/^\s*(do|don'?t|call|text|come|meet|send|bring|stop|go|get|be|let'?s)\b/)) directness += 2;
  directness = cl(directness);

  // --- humor: laughter tokens, jokey markers, winks.
  const humor = cl(count(/\b(lol|lmao|lmfao|haha+|hehe|jk|just kidding|rofl|lmaooo)\b/g) * 2 + (has(/[😂😅😜😏🤣😆]/u) ? 2 : 0));

  // --- punctuation expressiveness.
  let punctuation = cl(exclaims + questions + ellipses + emojis * 2 - 1);
  if (noEndPunct && emojis === 0) punctuation = cl(punctuation - 1);

  // --- polish: capitalized + terminal punctuation high; lowercase/slang low.
  let polish = 0;
  if (/^[A-Z]/.test(body)) polish += 1;
  if (/[.!?]$/.test(body)) polish += 1;
  if (allLower) polish -= 2;
  if (noEndPunct) polish -= 1;
  if (slangHits > 0) polish -= 1;
  polish = cl(polish);

  return { warmth, formality, brevity, energy, directness, humor, punctuation, polish };
}

// Parse the styleProfiles array off a request body into validated profiles.
export function parseIncomingStyleProfiles(raw: any): IncomingStyleProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingStyleProfile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const recipientName = String(item.recipientName || "").trim();
    const recipientKey = String(item.recipientKey || "").trim() || normalizeRecipientKey({ name: recipientName });
    if (!recipientName && !recipientKey) continue;
    out.push({ recipientKey, recipientName, vector: clampStyleVector(item.vector) });
  }
  // Defensive cap so a malformed client can't flood the prompt.
  return out.slice(0, 12);
}
