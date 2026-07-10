import { withTimeout } from "./util.js";

/* ============================================================================
 * Voice mode (Phase 1) — ElevenLabs speech-to-text + text-to-speech. The key
 * stays server-side (never shipped to the app). The device records a clip, we
 * transcribe it, run the normal assistant pipeline, then synthesize the reply.
 * ==========================================================================*/

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
// A good default voice + low-latency models; all overridable via env.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";

export function isVoiceConfigured(): boolean {
  return !!ELEVEN_KEY;
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
  try {
    const res: any = await withTimeout(
      fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } }),
      12000, "Voices"
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.voices) ? data.voices : [])
      .map((v: any) => ({ id: String(v.voice_id || ""), name: String(v.name || "Voice") }))
      .filter((v: { id: string }) => v.id);
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

export async function synthesize(text: string, voiceId?: string, variability?: number): Promise<string> {
  if (!ELEVEN_KEY || !text.trim()) return "";
  const vid = voiceId && voiceId.trim() ? voiceId.trim() : VOICE_ID;
  try {
    const res: any = await withTimeout(
      fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`, {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: text.slice(0, 2500),
          model_id: TTS_MODEL,
          voice_settings: { stability: stabilityForVariability(variability), similarity_boost: 0.75 }
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
