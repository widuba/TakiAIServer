/**
 * Compatibility adapter from Taki's existing Gemini-shaped request/response
 * contract to OpenAI's Responses API. Keeping this translation at the provider
 * boundary lets iPhone, iPad, CarPlay, planning, and voice streaming continue
 * using the same internal interfaces.
 */

export type FetchLike = typeof fetch;

export class UnsupportedOpenAIInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOpenAIInputError";
  }
}

export class OpenAIHTTPError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody = "") {
    super(message);
    this.name = "OpenAIHTTPError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function fileNameForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "application/json": "json",
    "application/xml": "xml",
    "application/rtf": "rtf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/csv": "csv",
    "text/plain": "txt",
    "text/markdown": "md"
  };
  return `attachment.${extensions[mime] || "bin"}`;
}

function inputPart(part: any): any | null {
  if (typeof part === "string") return { type: "input_text", text: part };
  if (typeof part?.text === "string") return { type: "input_text", text: part.text };

  const inline = part?.inlineData || part?.inline_data;
  if (inline?.data) {
    const mime = String(inline.mimeType || inline.mime_type || "application/octet-stream").toLowerCase();
    const dataURL = `data:${mime};base64,${inline.data}`;
    if (mime.startsWith("image/")) {
      return { type: "input_image", image_url: dataURL, detail: "auto" };
    }
    if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      // Responses does not accept these as ordinary input_file items.
      // Let the provider router preserve the existing Gemini behavior instead.
      throw new UnsupportedOpenAIInputError(`OpenAI file input does not support ${mime}.`);
    }
    return {
      type: "input_file",
      filename: fileNameForMime(mime),
      file_data: dataURL,
      ...(mime === "application/pdf" ? { detail: "low" } : {})
    };
  }

  const file = part?.fileData || part?.file_data;
  const uri = String(file?.fileUri || file?.file_uri || "").trim();
  if (uri) {
    if (/\.pdf(?:$|[?#])/i.test(uri)) {
      return { type: "input_file", file_url: uri, detail: "low" };
    }
    // Gemini accepts public video URLs as file data. OpenAI's normal file input
    // does not, so route these requests to the compatibility fallback.
    throw new UnsupportedOpenAIInputError("This public media URL requires the Gemini attachment fallback.");
  }
  return null;
}

function messageFromParts(parts: any[], role = "user"): any {
  const content = parts.map(inputPart).filter(Boolean);
  return { role, content: content.length ? content : [{ type: "input_text", text: "" }] };
}

export function openAIInputFromGeminiContents(contents: any): any {
  if (typeof contents === "string") return contents;
  if (!Array.isArray(contents)) {
    if (Array.isArray(contents?.parts)) {
      return [messageFromParts(contents.parts, String(contents.role || "user"))];
    }
    const part = inputPart(contents);
    return part ? [messageFromParts([contents])] : String(contents || "");
  }

  const hasMessages = contents.some((item) => Array.isArray(item?.parts));
  if (hasMessages) {
    return contents.map((item) => {
      const role = String(item?.role || "user").toLowerCase() === "model" ? "assistant" : String(item?.role || "user");
      return messageFromParts(Array.isArray(item?.parts) ? item.parts : [item], role);
    });
  }
  return [messageFromParts(contents)];
}

function reasoningEffort(model: string, config: any): "none" | "low" | "medium" {
  const requested = String(config?.openAIReasoningEffort || config?.openai_reasoning_effort || "").toLowerCase();
  if (requested === "none" || requested === "low" || requested === "medium") return requested;
  const thinking = config?.thinkingConfig || config?.thinking_config || {};
  const level = String(thinking?.thinkingLevel || thinking?.thinking_level || "").toUpperCase();
  if (Number(thinking?.thinkingBudget ?? thinking?.thinking_budget) === 0 || level === "MINIMAL") return "none";
  if (level === "LOW") return "low";
  return /gpt-5\.(?:4|5|6)(?:-pro|-sol)?$/i.test(model) ? "medium" : "none";
}

function requestsWebSearch(config: any): boolean {
  return Array.isArray(config?.tools) && config.tools.some((tool: any) =>
    tool?.googleSearch || tool?.google_search || tool?.urlContext || tool?.url_context
  );
}

export function buildOpenAIRequest(args: any, selectedModel: string, stream = false): any {
  const config = args?.config || {};
  const request: any = {
    model: selectedModel,
    input: openAIInputFromGeminiContents(args?.contents),
    store: false,
    stream,
    reasoning: { effort: reasoningEffort(selectedModel, config) }
  };

  const maxOutput = Number(config?.maxOutputTokens ?? config?.max_output_tokens);
  if (Number.isFinite(maxOutput) && maxOutput > 0) request.max_output_tokens = Math.floor(maxOutput);
  if (config?.responseMimeType === "application/json" || config?.response_mime_type === "application/json") {
    request.text = { format: { type: "json_object" } };
  }
  if (requestsWebSearch(config)) {
    request.tools = [{ type: "web_search", search_context_size: "medium" }];
  }
  return request;
}

function outputTextAndCitations(response: any): {
  text: string;
  citations: Array<{ title: string; url: string }>;
} {
  let text = "";
  const citations: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") text += content.text;
      if (content?.type === "refusal" && typeof content.refusal === "string") text += content.refusal;
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (annotation?.type !== "url_citation") continue;
        const url = String(annotation?.url || "").trim();
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        let title = String(annotation?.title || "").trim();
        if (!title) {
          try { title = new URL(url).hostname.replace(/^www\./, ""); } catch { title = "Web source"; }
        }
        citations.push({ title: title.slice(0, 140), url });
      }
    }
  }
  return { text, citations };
}

function webSearchQueries(response: any): string[] {
  const queries = new Set<string>();
  let usedSearch = false;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "web_search_call") continue;
    usedSearch = true;
    const action = item?.action;
    const values = Array.isArray(action?.queries)
      ? action.queries
      : typeof action?.query === "string"
        ? [action.query]
        : [];
    for (const value of values) {
      const query = String(value || "").trim();
      if (query) queries.add(query);
    }
  }
  return [...queries].length ? [...queries] : usedSearch ? ["OpenAI web search"] : [];
}

export function normalizeOpenAIResponse(response: any): any {
  const { text, citations } = outputTextAndCitations(response);
  const queries = webSearchQueries(response);
  const groundingChunks = citations.map((source) => ({
    web: { uri: source.url, title: source.title }
  }));
  const usage = response?.usage || {};
  return {
    text,
    candidates: [{
      groundingMetadata: {
        groundingChunks,
        groundingSupports: citations.map((_, index) => ({ groundingChunkIndices: [index] })),
        webSearchQueries: queries
      }
    }],
    usageMetadata: {
      promptTokenCount: Math.max(0, Number(usage?.input_tokens) || 0),
      candidatesTokenCount: Math.max(0, Number(usage?.output_tokens) || 0),
      totalTokenCount: Math.max(0, Number(usage?.total_tokens) || 0)
    },
    provider: "openai",
    providerModel: String(response?.model || ""),
    _openaiResponse: response
  };
}

function apiErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message || parsed?.message || `OpenAI request failed (${status})`);
  } catch {
    return body.trim().slice(0, 500) || `OpenAI request failed (${status})`;
  }
}

function requestHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  const organization = String(process.env.OPENAI_ORG_ID || "").trim();
  const project = String(process.env.OPENAI_PROJECT_ID || "").trim();
  if (organization) headers["OpenAI-Organization"] = organization;
  if (project) headers["OpenAI-Project"] = project;
  return headers;
}

function endpoint(): string {
  const base = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return `${base}/responses`;
}

export async function generateOpenAIContent(
  args: any,
  selectedModel: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<any> {
  const response = await fetchImpl(endpoint(), {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify(buildOpenAIRequest(args, selectedModel, false))
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OpenAIHTTPError(response.status, apiErrorMessage(response.status, body), body);
  }
  return normalizeOpenAIResponse(await response.json());
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseBlock = (block: string): any | null => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return null;
    return JSON.parse(data);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseBlock(block);
      if (event) yield event;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = parseBlock(buffer);
    if (event) yield event;
  }
}

export async function* generateOpenAIContentStream(
  args: any,
  selectedModel: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): AsyncGenerator<any> {
  const response = await fetchImpl(endpoint(), {
    method: "POST",
    headers: { ...requestHeaders(apiKey), Accept: "text/event-stream" },
    body: JSON.stringify(buildOpenAIRequest(args, selectedModel, true))
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OpenAIHTTPError(response.status, apiErrorMessage(response.status, body), body);
  }
  if (!response.body) throw new OpenAIHTTPError(502, "OpenAI returned an empty response stream.");

  for await (const event of sseEvents(response.body)) {
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield { text: event.delta, provider: "openai" };
      continue;
    }
    if (event?.type === "response.completed" && event.response) {
      const normalized = normalizeOpenAIResponse(event.response);
      // The full text must not be emitted again after incremental deltas.
      yield { ...normalized, text: "", _streamCompleted: true };
      continue;
    }
    if (event?.type === "response.failed" || event?.type === "error") {
      const error = event?.response?.error || event?.error || event;
      throw new OpenAIHTTPError(
        Number(error?.status || error?.code) || 502,
        String(error?.message || "OpenAI response stream failed.")
      );
    }
  }
}
