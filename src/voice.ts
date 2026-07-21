import { MAX_VOICE_INPUT_MS } from "./credits.js";
import { withTimeout } from "./util.js";

/* ============================================================================
 * Voice mode (Phase 1) — ElevenLabs speech-to-text + text-to-speech. The key
 * stays server-side (never shipped to the app). The device records a clip, we
 * transcribe it, run the normal assistant pipeline, then synthesize the reply.
 * ==========================================================================*/

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
// A good default voice. Flash v2.5 keeps conversational turns low-latency while
// retaining multilingual support; Taki normalizes numbers before synthesis.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
export const STT_MODEL = "scribe_v2";
export const TTS_MODEL = "eleven_flash_v2_5";

export function isVoiceConfigured(): boolean {
  return !!ELEVEN_KEY;
}

let voiceListCache: { expiresAt: number; voices: { id: string; name: string }[] } | null = null;

// New app builds report AVAudioRecorder duration directly. The byte estimate is
// a server-side floor for older or modified clients recording 32 kbps AAC.
export function billableAudioDurationMs(audioBase64: string, reportedMs?: number): number {
  const reported = Math.max(0, Math.min(MAX_VOICE_INPUT_MS, Math.floor(Number(reportedMs) || 0)));
  const padding = audioBase64.endsWith("==") ? 2 : audioBase64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor(audioBase64.length * 3 / 4) - padding);
  const estimated = Math.max(0, Math.min(MAX_VOICE_INPUT_MS, Math.round(bytes / 4)));
  return Math.max(reported, estimated);
}

// Transcribe a base64 audio clip → text. Returns "" on failure.
export async function transcribe(audioBase64: string, mime = "audio/m4a"): Promise<string> {
  if (!ELEVEN_KEY || !audioBase64) return "";
  try {
    const bytes = new Uint8Array(Buffer.from(audioBase64, "base64"));
    const form = new FormData();
    const ext = mime.includes("mp") || mime.includes("m4a") || mime.includes("aac") ? "m4a" : mime.includes("wav") ? "wav" : "audio";
    form.append("file", new Blob([bytes], { type: mime }), `clip.${ext}`);
    form.append("model_id", STT_MODEL);
    // Do NOT transcribe non-speech: otherwise scribe emits "(footsteps)",
    // "(conversation)", "(music)" tags that pollute the transcript (and confuse
    // the brain) when the user is walking or in a noisy place.
    form.append("tag_audio_events", "false");
    form.append("diarize", "false");
    const res: any = await withTimeout(
      fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_KEY },
        body: form as any
      }),
      20000, "STT"
    );
    if (!res.ok) {
      console.error("STT error:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return "";
    }
    const data = await res.json();
    if (typeof data?.text !== "string") return "";
    // Belt-and-suspenders: strip any residual "(footsteps)"-style audio-event
    // tags (single short parentheticals with no sentence punctuation).
    const cleaned = data.text
      .replace(/\((?:[^()]{0,30})\)/g, (m: string) => (/[.?!,]/.test(m) ? m : " "))
      .replace(/\s{2,}/g, " ")
      .trim();
    return cleaned;
  } catch (error) {
    console.error("Transcribe error:", error);
    return "";
  }
}

// The available voices for the account, for the app's voice picker.
export async function listVoices(): Promise<{ id: string; name: string }[]> {
  if (!ELEVEN_KEY) return [];
  if (voiceListCache && voiceListCache.expiresAt > Date.now()) return voiceListCache.voices;
  try {
    const res: any = await withTimeout(
      fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } }),
      12000, "Voices"
    );
    if (!res.ok) return [];
    const data = await res.json();
    const voices = (Array.isArray(data?.voices) ? data.voices : [])
      .map((v: any) => ({ id: String(v.voice_id || ""), name: String(v.name || "Voice") }))
      .filter((v: { id: string }) => v.id);
    voiceListCache = { expiresAt: Date.now() + 10 * 60_000, voices };
    return voices;
  } catch (error) {
    console.error("List voices error:", error);
    return [];
  }
}

// Synthesize text → base64 mp3. Returns "" on failure (caller falls back to text).
export function stabilityForVariability(variability?: number): number {
  const v = Number.isFinite(variability) ? Math.max(0, Math.min(1, variability as number)) : 0.5;
  // ElevenLabs stability is inverse to the user-facing control: lower stability
  // yields a more expressive, variable delivery. Keep away from either extreme.
  return Number((0.8 - v * 0.6).toFixed(2));
}

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Array<[bigint, string]> = [
  [1_000_000_000_000_000n, "quadrillion"],
  [1_000_000_000_000n, "trillion"],
  [1_000_000_000n, "billion"],
  [1_000_000n, "million"],
  [1_000n, "thousand"]
];

function integerToWords(value: bigint): string {
  if (value < 20n) return SMALL_NUMBERS[Number(value)];
  if (value < 100n) {
    const rest = value % 10n;
    return `${TENS[Number(value / 10n)]}${rest ? ` ${SMALL_NUMBERS[Number(rest)]}` : ""}`;
  }
  if (value < 1_000n) {
    const rest = value % 100n;
    return `${SMALL_NUMBERS[Number(value / 100n)]} hundred${rest ? ` ${integerToWords(rest)}` : ""}`;
  }
  for (const [size, label] of SCALES) {
    if (value >= size) {
      const rest = value % size;
      return `${integerToWords(value / size)} ${label}${rest ? ` ${integerToWords(rest)}` : ""}`;
    }
  }
  return value.toString();
}

function digitsToWords(value: string): string {
  return [...value].map((digit) => SMALL_NUMBERS[Number(digit)]).join(" ");
}

function spokenNumericToken(token: string, nearbyText: string): string {
  const parsed = token.match(/^(-)?(\$)?([\d,]+)(?:\.(\d+))?(%)?$/);
  if (!parsed) return token;
  const [, negative, currency, rawWhole, fraction, percent] = parsed;
  const whole = rawWhole.replace(/,/g, "");
  if (!/^\d+$/.test(whole)) return token;

  const digitStyle = (whole.length > 1 && whole.startsWith("0"))
    || whole.length > 15
    || /\b(phone|call|text|code|pin|account|confirmation|verification)\b/i.test(nearbyText);
  const base = digitStyle ? digitsToWords(whole) : integerToWords(BigInt(whole));
  const signed = negative ? `negative ${base}` : base;
  if (currency) {
    const dollars = `${signed} dollar${whole === "1" ? "" : "s"}`;
    if (!fraction || Number(fraction) === 0) return dollars;
    const centsValue = BigInt((fraction + "00").slice(0, 2));
    return `${dollars} and ${integerToWords(centsValue)} cent${centsValue === 1n ? "" : "s"}`;
  }
  const decimal = fraction ? `${signed} point ${digitsToWords(fraction)}` : signed;
  return percent ? `${decimal} percent` : decimal;
}

// Keep numbers readable in chat while giving ElevenLabs natural spoken words.
// Replacements are bounded to the existing voice response budget so number
// expansion cannot silently increase included-plan cost or create long audio.
export function normalizeTextForSpeech(text: string): string {
  const budget = Math.max(140, text.length);
  const tokenPattern = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index;
    const nearby = text.slice(Math.max(0, index - 32), Math.min(text.length, index + token.length + 32));
    const replacement = spokenNumericToken(token, nearby);
    const prefix = text.slice(lastIndex, index);
    const remainingLength = text.length - (index + token.length);
    result += prefix;
    result += result.length + replacement.length + remainingLength <= budget ? replacement : token;
    lastIndex = index + token.length;
  }
  const normalized = result + text.slice(lastIndex);
  const spokenOperators = normalized.replace(/\s+(?:x|×|\*)\s+/gi, " times ");
  return spokenOperators.length <= budget ? spokenOperators : normalized;
}

export function speechCharacterCount(text: string): number {
  return normalizeTextForSpeech(text).length;
}

export async function synthesize(text: string, voiceId?: string, variability?: number): Promise<string> {
  if (!ELEVEN_KEY || !text.trim()) return "";
  const vid = voiceId && voiceId.trim() ? voiceId.trim() : VOICE_ID;
  const spokenText = normalizeTextForSpeech(text);
  try {
    // Higher MP3 bitrate improves consonant clarity without changing ElevenLabs'
    // per-character charge. Flash v2.5 remains the low-latency, half-price model.
    const res: any = await withTimeout(
      fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: spokenText.slice(0, 2500),
          model_id: TTS_MODEL,
          voice_settings: {
            stability: stabilityForVariability(variability),
            similarity_boost: 0.82,
            use_speaker_boost: true
          }
        })
      }),
      20000, "TTS"
    );
    if (!res.ok) {
      console.error("TTS error:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return "";
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch (error) {
    console.error("Synthesize error:", error);
    return "";
  }
}
