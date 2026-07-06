import { ai, MAIN_MODEL } from "./ai.js";
import { withTimeout } from "./util.js";
import { GUARDRAILS, personaPromptBlock } from "./persona.js";
import { storeGet, storeSet } from "./store.js";
import type { ConversationState } from "./types.js";

/* ============================================================================
 * Email inbox integration — provider-agnostic over Gmail + Microsoft Outlook.
 *
 * The user connects an account once (OAuth, server holds the refresh token,
 * scoped per 8-digit device identity). Afterwards Taki can read / search /
 * summarize the inbox on request. All API calls are server-side; the device only
 * displays the resulting summary. Sending still uses the native composer
 * (compose_email) — this module is READ-focused for now.
 *
 * OAuth is server-side code-exchange: the redirect_uri points at this server's
 * /api/email/callback, which swaps the code for tokens using the client secret,
 * stores the refresh token, and bounces the browser back to the app via the
 * takiai:// deep link. Nothing is inert-safe to log; tokens live only in the
 * durable store under "email:conn:<deviceId>".
 * ==========================================================================*/

export type EmailProvider = "gmail" | "outlook";

export interface EmailConnection {
  provider: EmailProvider;
  refreshToken: string;
  email: string;
  connectedAt: number;
}

export interface EmailMessage {
  id: string;
  from: string;     // "Name <addr>" or just the address
  subject: string;
  snippet: string;
  date: string;     // ISO-ish or provider string
  unread: boolean;
}

// The server's own public base (must match the redirect URI registered with the
// providers). Defaults to Render; override with API_BASE_URL if that changes.
const API_BASE_URL = process.env.API_BASE_URL || "https://takiaiserver.onrender.com";
const REDIRECT_URI = `${API_BASE_URL}/api/email/callback`;

interface ProviderCfg {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
}

function cfg(provider: EmailProvider): ProviderCfg | null {
  if (provider === "gmail") {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // gmail.readonly is a restricted scope (needs Google app verification for
      // >100 users); openid/email so we can read the address.
      scopes: "openid email https://www.googleapis.com/auth/gmail.readonly"
    };
  }
  const clientId = process.env.MS_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.MS_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: "openid email offline_access User.Read Mail.Read"
  };
}

export function emailProviderConfigured(provider: EmailProvider): boolean {
  return cfg(provider) !== null;
}
export function anyEmailProviderConfigured(): boolean {
  return emailProviderConfigured("gmail") || emailProviderConfigured("outlook");
}

/* ---- OAuth state (CSRF nonce → deviceId/provider) ----------------------- */

function stateKey(nonce: string): string {
  return `email:oauthstate:${nonce.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
export async function createOAuthState(deviceId: string, provider: EmailProvider): Promise<string> {
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  await storeSet(stateKey(nonce), { deviceId, provider, at: Date.now() });
  return nonce;
}
async function consumeOAuthState(nonce: string): Promise<{ deviceId: string; provider: EmailProvider } | null> {
  const s = await storeGet<{ deviceId: string; provider: EmailProvider; at: number } | null>(stateKey(nonce), null);
  if (!s || !s.deviceId) return null;
  await storeSet(stateKey(nonce), null); // one-time use
  if (Date.now() - (s.at || 0) > 15 * 60 * 1000) return null; // 15-min window
  return { deviceId: s.deviceId, provider: s.provider };
}

// Build the provider's consent URL. `state` is our stored nonce.
export function buildAuthUrl(provider: EmailProvider, state: string): string | null {
  const c = cfg(provider);
  if (!c) return null;
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: c.scopes,
    state,
    access_type: "offline",     // Google: get a refresh token
    prompt: "consent"           // force refresh_token issuance on re-consent
  });
  return `${c.authUrl}?${params.toString()}`;
}

/* ---- Token exchange + storage ------------------------------------------- */

interface TokenResponse { access_token?: string; refresh_token?: string; error?: string; error_description?: string; }

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const r: any = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString()
    }),
    15000, "OAuth token"
  );
  return (await r.json()) as TokenResponse;
}

function connKey(deviceId: string): string {
  return `email:conn:${deviceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
export async function loadConnection(deviceId: string): Promise<EmailConnection | null> {
  if (!deviceId) return null;
  return await storeGet<EmailConnection | null>(connKey(deviceId), null);
}
export async function disconnectEmail(deviceId: string): Promise<void> {
  await storeSet(connKey(deviceId), null);
}
export async function emailConnected(deviceId: string): Promise<boolean> {
  const c = await loadConnection(deviceId);
  return !!(c && c.refreshToken);
}

// Exchange the auth code for tokens, look up the address, and persist the
// connection under the identity carried in `state`. Returns the connected email.
export async function completeOAuth(code: string, state: string): Promise<{ deviceId: string; provider: EmailProvider; email: string } | null> {
  const st = await consumeOAuthState(state);
  if (!st) return null;
  const c = cfg(st.provider);
  if (!c) return null;
  const tok = await postForm(c.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: c.clientId,
    client_secret: c.clientSecret
  });
  if (!tok.refresh_token || !tok.access_token) {
    console.error("email OAuth exchange failed:", tok.error, tok.error_description);
    return null;
  }
  const email = await fetchAddress(st.provider, tok.access_token);
  const conn: EmailConnection = { provider: st.provider, refreshToken: tok.refresh_token, email, connectedAt: Date.now() };
  await storeSet(connKey(st.deviceId), conn);
  return { deviceId: st.deviceId, provider: st.provider, email };
}

// Refresh and return a live access token for the stored connection.
async function accessTokenFor(conn: EmailConnection): Promise<string | null> {
  const c = cfg(conn.provider);
  if (!c) return null;
  const tok = await postForm(c.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: conn.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret
  });
  return tok.access_token || null;
}

/* ---- Provider adapters (normalized) ------------------------------------- */

async function getJson(url: string, token: string): Promise<any> {
  const r: any = await withTimeout(
    fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }),
    15000, "email API"
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`email API ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchAddress(provider: EmailProvider, token: string): Promise<string> {
  try {
    if (provider === "gmail") {
      const p = await getJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", token);
      return p.emailAddress || "";
    }
    const me = await getJson("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", token);
    return me.mail || me.userPrincipalName || "";
  } catch { return ""; }
}

function stripHtml(s: string): string {
  return String(s || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

// List/search recent messages, normalized. `query` is a plain search string
// (mapped to each provider's syntax). `wantBody` fetches the top message's text.
async function listMessages(conn: EmailConnection, token: string, query: string, max: number): Promise<EmailMessage[]> {
  if (conn.provider === "gmail") {
    const q = query ? `&q=${encodeURIComponent(query)}` : "";
    const list = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}${q}`, token);
    const ids: string[] = (list.messages || []).map((m: any) => m.id).slice(0, max);
    const out: EmailMessage[] = [];
    for (const id of ids) {
      const m = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
      const h: Record<string, string> = {};
      for (const hd of m.payload?.headers || []) h[hd.name.toLowerCase()] = hd.value;
      out.push({
        id,
        from: h["from"] || "",
        subject: h["subject"] || "(no subject)",
        snippet: stripHtml(m.snippet || ""),
        date: h["date"] || "",
        unread: (m.labelIds || []).includes("UNREAD")
      });
    }
    return out;
  }
  // Outlook / Microsoft Graph
  const base = "https://graph.microsoft.com/v1.0/me/messages";
  const sel = "$select=from,subject,bodyPreview,receivedDateTime,isRead";
  const url = query
    ? `${base}?$search=${encodeURIComponent(`"${query}"`)}&${sel}&$top=${max}`
    : `${base}?${sel}&$top=${max}&$orderby=receivedDateTime desc`;
  const list = await getJson(url, token);
  return (list.value || []).slice(0, max).map((m: any): EmailMessage => ({
    id: m.id,
    from: m.from?.emailAddress ? `${m.from.emailAddress.name || ""} <${m.from.emailAddress.address || ""}>`.trim() : "",
    subject: m.subject || "(no subject)",
    snippet: stripHtml(m.bodyPreview || ""),
    date: m.receivedDateTime || "",
    unread: m.isRead === false
  }));
}

async function fetchBody(conn: EmailConnection, token: string, id: string): Promise<string> {
  try {
    if (conn.provider === "gmail") {
      const m = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, token);
      const parts: string[] = [];
      const walk = (p: any) => {
        if (!p) return;
        if (p.mimeType === "text/plain" && p.body?.data) parts.push(Buffer.from(p.body.data, "base64").toString("utf8"));
        else if (p.mimeType === "text/html" && p.body?.data && parts.length === 0) parts.push(stripHtml(Buffer.from(p.body.data, "base64").toString("utf8")));
        for (const c of p.parts || []) walk(c);
      };
      walk(m.payload);
      return (parts.join("\n") || stripHtml(m.snippet || "")).slice(0, 6000);
    }
    const m = await getJson(`https://graph.microsoft.com/v1.0/me/messages/${id}?$select=body,subject,from`, token);
    const content = m.body?.contentType === "html" ? stripHtml(m.body.content) : (m.body?.content || "");
    return String(content).slice(0, 6000);
  } catch { return ""; }
}

/* ---- High-level: fetch + summarize -------------------------------------- */

// Result of an inbox request: either not-connected (so the caller can prompt the
// user to connect), or a natural-language answer.
export type EmailResult =
  | { connected: false }
  | { connected: true; answer: string };

// Build the answer for an email request. `kind`: "summary" = inbox overview;
// "search" = messages matching `query`; "latest" = read the most recent one.
export async function answerEmail(
  state: ConversationState,
  kind: "summary" | "search" | "latest",
  query: string
): Promise<EmailResult> {
  const deviceId = state.deviceId || "";
  const conn = await loadConnection(deviceId);
  if (!conn || !conn.refreshToken) return { connected: false };

  let token: string | null;
  try {
    token = await accessTokenFor(conn);
  } catch (e) {
    console.error("email token refresh:", e);
    token = null;
  }
  if (!token) {
    return { connected: true, answer: "I couldn't reach your email account — it may need reconnecting in Settings." };
  }

  try {
    const max = kind === "latest" ? 1 : 8;
    const messages = await listMessages(conn, token, kind === "search" ? query : "", max);
    if (messages.length === 0) {
      return {
        connected: true,
        answer: kind === "search" ? `I didn't find any emails matching "${query}".` : "Your inbox looks clear — no recent emails."
      };
    }
    let bodyBlock = "";
    if (kind === "latest") {
      const body = await fetchBody(conn, token, messages[0].id);
      if (body) bodyBlock = `\n\nFULL TEXT OF THE LATEST MESSAGE:\n${body}`;
    }
    const digest = messages
      .map((m, i) => `${i + 1}. ${m.unread ? "[unread] " : ""}From: ${m.from}\n   Subject: ${m.subject}\n   ${m.snippet}`)
      .join("\n");
    const answer = await summarizeEmails(state, kind, query, conn.email, digest + bodyBlock);
    return { connected: true, answer };
  } catch (e) {
    console.error("answerEmail error:", e);
    return { connected: true, answer: "I had trouble reading your email just now — please try again in a moment." };
  }
}

async function summarizeEmails(state: ConversationState, kind: string, query: string, address: string, digest: string): Promise<string> {
  const lengthRule = state.voiceMode
    ? "Answer in ONE or two short sentences (it's read aloud). Mention only the most important items."
    : "Give a brief, scannable rundown — a short lead line, then up to 5 tight bullets (sender — subject — why it matters). Keep it under ~120 words.";
  const framing = kind === "search"
    ? `The user searched their email for "${query}". Summarize what you found.`
    : kind === "latest"
      ? `Summarize the user's most recent email, including what it's about and anything they'd need to act on.`
      : `Summarize the user's recent inbox: how many are unread, and the highlights worth their attention.`;
  const prompt = `${GUARDRAILS}
You are Taki AI, helping the user triage their email (${address}).
${personaPromptBlock(state.userProfile)}
${framing}
- ${lengthRule}
- Only use what's in the messages below — never invent senders, subjects, or details.
- Flag anything time-sensitive (deadlines, bills, meetings, replies expected).
- Plain text. No "According to your inbox…" preamble; just tell them.

MESSAGES:
${digest}`;
  try {
    const r: any = await withTimeout(
      ai.models.generateContent({ model: MAIN_MODEL, contents: prompt, config: { thinkingConfig: { thinkingBudget: 0 } } } as any),
      20000, "email summary"
    );
    return String(r?.text || "").trim() || "I read your email but couldn't summarize it — try again.";
  } catch (e) {
    console.error("summarizeEmails error:", e);
    return "I had trouble summarizing your email.";
  }
}

/* ---- Intent detection (planner) ----------------------------------------- */

// Does this message ask about the user's email inbox? Returns the request kind +
// a portable search query, or null. Requires an inbox cue AND a read framing so
// "email mom that I'll be late" (a compose) is never captured here. The query
// uses `from:X` / bare-term syntax that works in BOTH Gmail's `q` and Graph's
// KQL `$search`.
export function detectEmailRequest(message: string): { kind: "summary" | "search" | "latest"; query: string } | null {
  const m = message.toLowerCase().trim();
  const hasEmailNoun = /\b(e-?mails?|inbox|gmail|outlook|\bmail\b)\b/.test(m);
  if (!hasEmailNoun) return null;
  // Never steal a compose/send ("send an email …", "write/draft an email …").
  if (/^(?:can you |could you |please )?(?:send|write|compose|draft|shoot|fire off)\b/.test(m)) return null;

  // "read/open my latest/last email"
  if (/\b(read|open|what does)\b[^.?!]*\b(latest|last|newest|recent|most recent)\b[^.?!]*\b(e-?mail|message)\b/.test(m) ||
      /\b(?:my )?(latest|last|newest|most recent) (e-?mail|message)\b/.test(m)) {
    return { kind: "latest", query: "" };
  }

  // Search by sender: "(any) emails from X", "mail from X"
  let mm = m.match(/\b(?:e-?mails?|mail|inbox|messages?)\s+(?:from|by)\s+(.+)/);
  if (mm) {
    const q = cleanQuery(mm[1]);
    if (q) return { kind: "search", query: `from:${q}` };
  }
  // Search by topic — require a plural "emails" OR an explicit search verb so a
  // singular "email about X" (usually a compose) doesn't get grabbed.
  mm = m.match(/\be-?mails\s+(?:about|regarding|re|on|mentioning)\s+(.+)/) ||
       m.match(/\b(?:find|search|look for|search for|any|show me|check for)\b[^.?!]*\b(?:e-?mails?|mail|messages?)\s+(?:about|regarding|for|on|mentioning)\s+(.+)/);
  if (mm) {
    const q = cleanQuery(mm[1]);
    if (q) return { kind: "search", query: q };
  }

  // Generic inbox overview: "check my email", "any new emails", "summarize my inbox"
  if (/\bsummar/.test(m) ||
      /\b(check|go through|catch me up on|read me)\b/.test(m) ||
      /\bwhat('?s| is) in my (e-?mail|inbox|mail)\b/.test(m) ||
      /\bany (new|unread|important)\b/.test(m) ||
      /\bdo i have (any )?(new |unread )?(e-?mails?|mail)\b/.test(m) ||
      /^(my )?(e-?mails?|inbox)\??$/.test(m)) {
    return { kind: "summary", query: "" };
  }
  return null;
}

function cleanQuery(raw: string): string {
  const q = raw
    .replace(/\bin my (inbox|email|mail)\b.*$/, "")
    .replace(/\b(please|today|recently|lately)\b/g, "")
    .replace(/[?.!]+$/, "")
    .replace(/^(the|a|an|my)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return q.length >= 1 && q.length <= 80 ? q : "";
}
