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
import { prepareGeminiRequest } from "../src/ai.js";
import { buildConversationState } from "../src/context.js";
import { runBrainV3Plan } from "../src/brainV3.js";

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
  assert.deepEqual(request.tools, [{ type: "web_search_preview", search_context_size: "medium" }]);
});

test("Brain v3 JSON stages use strict Responses Structured Outputs", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { decision: { type: "string" } },
    required: ["decision"]
  };
  const request = buildOpenAIRequest({
    contents: "Classify this turn.",
    config: {
      modelRole: "brain_v3",
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      responseJsonSchemaName: "taki_brain_v3_policy"
    }
  }, "gpt-5.5");

  assert.deepEqual(request.text, {
    format: {
      type: "json_schema",
      name: "taki_brain_v3_policy",
      strict: true,
      schema
    }
  });
});

test("Brain v3 runs end to end through the Responses adapter contract", async () => {
  const requestBodies: any[] = [];
  const requestHeaders: HeadersInit[] = [];
  const understanding = {
    intent: "answer_only",
    answerMode: "direct",
    speechAct: "question",
    tone: "neutral",
    sarcasm: "unlikely",
    language: "en",
    disfluencyDetected: true,
    repeatedFragments: ["can"],
    fillerWords: [],
    confidence: 0.98,
    needsClarification: false,
    clarifyingQuestion: null,
    missing: [],
    webQuery: null,
    researchQuery: null,
    wantsCalendar: false,
    event: null,
    action: null,
    contact: null,
    place: null
  };
  const policy = {
    decision: "allow",
    riskCategory: "none",
    confidence: 0.99,
    reason: "ordinary educational question",
    safeAlternative: ""
  };
  const responses: Record<string, unknown> = {
    taki_brain_v3_understanding: understanding,
    taki_brain_v3_policy: policy,
    taki_brain_v3_answer: { answer: "Leaves change color as chlorophyll breaks down and other pigments become visible." }
  };
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requestBodies.push(body);
    requestHeaders.push(init?.headers || {});
    const name = String(body?.text?.format?.name || "");
    const output = responses[name];
    assert.ok(output, `unexpected structured stage: ${name}`);
    return new Response(JSON.stringify({
      id: `resp_${requestBodies.length}`,
      model: body.model,
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
      usage: { input_tokens: 12, output_tokens: 18, total_tokens: 30 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const generateThroughResponses = (args: any) => generateOpenAIContent(
    args,
    "gpt-5.4-mini",
    "staging-contract-test-key",
    fetchImpl as typeof fetch
  );

  const result = await runBrainV3Plan(
    buildConversationState("C c can you explain why leaves change color?", "", undefined, "America/New_York", undefined, undefined, false, "adapter-contract"),
    undefined,
    { generateContent: generateThroughResponses }
  );

  assert.match(result.spokenText, /leaves change color|chlorophyll/i);
  assert.equal(result.action, null);
  assert.deepEqual(
    requestBodies.map((body) => body.text?.format?.name),
    ["taki_brain_v3_understanding", "taki_brain_v3_policy", "taki_brain_v3_answer"]
  );
  for (const body of requestBodies) {
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.stream, false);
  }
  assert.equal(requestHeaders.length, 3);
  assert.match(String((requestHeaders[0] as any).Authorization || (requestHeaders[0] as any).authorization || ""), /Bearer staging-contract-test-key/);
});

test("Brain v3 adapter metadata never leaks into Gemini config", () => {
  const request = prepareGeminiRequest({
    model: "gemini-3.1-pro-preview",
    contents: "Classify this turn.",
    config: {
      modelRole: "brain_v3",
      responseJsonSchemaName: "taki_brain_v3_policy",
      openAIReasoningEffort: "low",
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" }
    }
  }, "gemini-3.1-pro-preview");
  assert.equal(request.config.modelRole, undefined);
  assert.equal(request.config.responseJsonSchemaName, undefined);
  assert.equal(request.config.openAIReasoningEffort, undefined);
  assert.equal(request.config.responseMimeType, "application/json");
  assert.deepEqual(request.config.responseJsonSchema, { type: "object" });
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

  assert.deepEqual(request.tools, [{ type: "web_search_preview", search_context_size: "high" }]);
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
  assert.equal(content[1].detail, undefined);
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

test("the deep tier can drive Mini at high reasoning effort", () => {
  const request = buildOpenAIRequest({
    contents: "Think very carefully.",
    config: { openAIReasoningEffort: "high" }
  }, "gpt-5.4-mini");

  assert.equal(request.model, "gpt-5.4-mini");
  assert.equal(request.reasoning.effort, "high");
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
