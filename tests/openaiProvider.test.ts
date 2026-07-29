import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenAIRequest,
  generateOpenAIContent,
  generateOpenAIContentStream,
  normalizeOpenAIResponse,
  OpenAIHTTPError,
  UnsupportedOpenAIInputError
} from "../src/openaiProvider.js";

test("Gemini-shaped text, JSON, search, reasoning, and limits map to Responses", () => {
  const request = buildOpenAIRequest({
    contents: "Return a JSON object.",
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 240,
      thinkingConfig: { thinkingBudget: 0 },
      tools: [{ googleSearch: {} }]
    }
  }, "gpt-5.4-mini");

  assert.equal(request.model, "gpt-5.4-mini");
  assert.equal(request.input, "Return a JSON object.");
  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.reasoning.effort, "none");
  assert.equal(request.max_output_tokens, 240);
  assert.deepEqual(request.text, { format: { type: "json_object" } });
  assert.deepEqual(request.tools, [{ type: "web_search", search_context_size: "medium" }]);
});

test("time-sensitive requests can require higher-context Responses web search", () => {
  const request = buildOpenAIRequest({
    contents: "What are some good movies to watch this summer?",
    config: {
      tools: [{ googleSearch: {} }],
      forceWebSearch: true,
      webSearchContextSize: "high"
    }
  }, "gpt-5.4-mini");

  assert.deepEqual(request.tools, [{ type: "web_search", search_context_size: "high" }]);
  assert.equal(request.tool_choice, "required");
});

test("image and document inputs map to multimodal Responses content", () => {
  const request = buildOpenAIRequest({
    contents: [
      { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
      { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
      { text: "Explain both." }
    ]
  }, "gpt-5.4-mini");
  const content = request.input[0].content;
  assert.equal(content[0].type, "input_image");
  assert.equal(content[0].image_url, "data:image/png;base64,aW1hZ2U=");
  assert.equal(content[1].type, "input_file");
  assert.equal(content[1].filename, "attachment.pdf");
  assert.equal(content[1].detail, "low");
  assert.equal(content[2].text, "Explain both.");

  assert.throws(
    () => buildOpenAIRequest({
      contents: [{ inlineData: { mimeType: "audio/mpeg", data: "YXVkaW8=" } }]
    }, "gpt-5.4-mini"),
    UnsupportedOpenAIInputError
  );
});

test("OpenAI text, citations, search evidence, and usage normalize for Taki", () => {
  const normalized = normalizeOpenAIResponse({
    model: "gpt-5.4-mini",
    output: [
      { type: "web_search_call", action: { type: "search", queries: ["latest Taki news"] } },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: "A grounded answer.",
          annotations: [{
            type: "url_citation",
            title: "Example",
            url: "https://example.com/source"
          }]
        }]
      }
    ],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
  });

  assert.equal(normalized.text, "A grounded answer.");
  assert.equal(normalized.provider, "openai");
  assert.equal(normalized.usageMetadata.promptTokenCount, 100);
  assert.deepEqual(normalized.candidates[0].groundingMetadata.webSearchQueries, ["latest Taki news"]);
  assert.deepEqual(
    normalized.candidates[0].groundingMetadata.groundingChunks,
    [{ web: { uri: "https://example.com/source", title: "Example" } }]
  );
});

test("Responses streaming emits deltas once and retains final usage for metering", async () => {
  const completed = {
    model: "gpt-5.4-nano",
    output: [{ type: "message", content: [{ type: "output_text", text: "Hi there.", annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
  };
  const sse = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi " })}`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "there." })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
    "data: [DONE]"
  ].join("\n\n");
  const fetchImpl = async () => new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });

  const chunks: any[] = [];
  for await (const chunk of generateOpenAIContentStream(
    { contents: "Say hello.", config: { thinkingConfig: { thinkingBudget: 0 } } },
    "gpt-5.4-nano",
    "test-key",
    fetchImpl as typeof fetch
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["Hi ", "there.", ""]);
  assert.equal(chunks.at(-1)._streamCompleted, true);
  assert.equal(chunks.at(-1)._openaiResponse.usage.total_tokens, 13);
});

test("Taki can explicitly raise Mini reasoning without switching to a flagship model", () => {
  const request = buildOpenAIRequest({
    contents: "Think carefully.",
    config: { openAIReasoningEffort: "medium" }
  }, "gpt-5.4-mini");

  assert.equal(request.model, "gpt-5.4-mini");
  assert.equal(request.reasoning.effort, "medium");
});

test("a bounded provider attempt aborts a stuck OpenAI request", async () => {
  const fetchImpl = async (_input: any, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });

  await assert.rejects(
    generateOpenAIContent(
      { contents: "Hello", config: { providerAttemptTimeoutMs: 25 } },
      "gpt-5.4-mini",
      "test-key",
      fetchImpl as typeof fetch
    ),
    (error: unknown) => error instanceof OpenAIHTTPError && error.status === 408
  );
});
