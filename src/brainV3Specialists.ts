import { brainV3StructuredRequest, generateContent, safetyConfig, ServiceError } from "./ai.js";
import { extractJsonObject, withTimeout } from "./util.js";

/**
 * Strict contracts for model calls that sit below the Brain v3 planner.
 *
 * These are deliberately kept in a dependency-light module. The main Brain v3
 * imports device/web tools, so putting specialist contracts here avoids making
 * those tools import the whole planner and keeps the compatibility fallback
 * easy to exercise in tests.
 */

const NULLABLE_STRING = { type: ["string", "null"] } as const;

export const BRAIN_V3_WEB_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answer: { type: "string" } },
  required: ["answer"]
} as const;

export const BRAIN_V3_VENUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    venue: { type: "string" }
  },
  required: ["found", "venue"]
} as const;

export const BRAIN_V3_EVENT_MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { eventIndex: { type: "integer" } },
  required: ["eventIndex"]
} as const;

export const BRAIN_V3_ALARM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    valid: { type: "boolean" },
    hour: { type: "integer" },
    minute: { type: "integer" },
    ampmGiven: { type: "boolean" },
    dayOffset: { type: "integer" },
    label: { type: "string" }
  },
  required: ["valid", "hour", "minute", "ampmGiven", "dayOffset", "label"]
} as const;

export const BRAIN_V3_TIMER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    seconds: { type: "integer" },
    label: { type: "string" }
  },
  required: ["seconds", "label"]
} as const;

export const BRAIN_V3_MATH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expr: NULLABLE_STRING,
    label: { type: "string" }
  },
  required: ["expr", "label"]
} as const;

export const BRAIN_V3_STYLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"]
} as const;

export const BRAIN_V3_EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    localDate: { type: "string" },
    localTime: { type: "string" },
    location: { type: "string" },
    notes: { type: "string" },
    reason: { type: "string" }
  },
  required: ["found", "title", "localDate", "localTime", "location", "notes", "reason"]
} as const;

export const BRAIN_V3_EVENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          localDate: { type: "string" },
          localTime: { type: "string" },
          location: { type: "string" },
          notes: { type: "string" }
        },
        required: ["title", "localDate", "localTime", "location", "notes"]
      }
    }
  },
  required: ["events"]
} as const;

export const BRAIN_V3_SPORTS_TRACKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    eventDate: { type: "string" },
    title: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string" },
    status: { type: "string" }
  },
  required: ["found", "eventDate", "title", "line1", "line2", "status"]
} as const;

export const BRAIN_V3_PRODUCT_TRACKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string" },
    status: { type: "string" }
  },
  required: ["found", "title", "line1", "line2", "status"]
} as const;

export const BRAIN_V3_FLIGHT_TRACKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    dep: { type: "string" },
    arr: { type: "string" },
    depColor: { type: "string", enum: ["green", "yellow", "red", ""] },
    arrColor: { type: "string", enum: ["green", "yellow", "red", ""] },
    status: { type: "string" },
    trend: { type: "string", enum: ["up", "down", "flat"] }
  },
  required: ["found", "title", "dep", "arr", "depColor", "arrColor", "status", "trend"]
} as const;

export type BrainV3SpecialistOptions = {
  timeoutMs: number;
  maxOutputTokens?: number;
  reasoning?: "none" | "low" | "medium" | "high";
  teen?: boolean;
  [key: string]: unknown;
};

export type BrainV3StructuredGenerator = (args: any) => Promise<any>;

let specialistCircuitOpenUntil = 0;

function specialistFailureCooldownMs(error: unknown): number {
  if (error instanceof ServiceError) {
    switch (error.kind) {
      case "ai_auth": return 5 * 60_000;
      case "ai_quota": return 30_000;
      case "ai_timeout": return 15_000;
      case "ai_unavailable": return 20_000;
      default: return 10_000;
    }
  }
  return 10_000;
}

/** The auxiliary boundary must fail over quickly instead of retrying every surface. */
export function brainV3SpecialistCircuitOpen(now = Date.now()): boolean {
  return specialistCircuitOpenUntil > now;
}

export function resetBrainV3SpecialistCircuit(): void {
  specialistCircuitOpenUntil = 0;
}

/** Local defense-in-depth check for provider JSON, including nested objects. */
export function brainV3SchemaMatches(value: unknown, schema: Record<string, any>): boolean {
  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (declaredTypes.length) {
    const typeMatches = declaredTypes.some((type: unknown) => {
      switch (type) {
        case "null": return value === null;
        case "object": return !!value && typeof value === "object" && !Array.isArray(value);
        case "array": return Array.isArray(value);
        case "string": return typeof value === "string";
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "integer": return typeof value === "number" && Number.isInteger(value);
        case "boolean": return typeof value === "boolean";
        default: return false;
      }
    });
    if (!typeMatches) return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => Object.is(item, value))) return false;
  // Nullable unions are complete once their null branch matched. Object and
  // array constraints only apply to their corresponding non-null value.
  if (value === null) return true;

  if (typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, Record<string, any>>
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!required.every((key: unknown) => typeof key === "string" && Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && !brainV3SchemaMatches((value as Record<string, unknown>)[key], childSchema)) return false;
    }
  }

  if (Array.isArray(value) && schema.items && !value.every((item) => brainV3SchemaMatches(item, schema.items))) return false;
  return true;
}

function completeTopLevelObject(value: unknown, schema: Record<string, unknown>): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && brainV3SchemaMatches(value, schema as Record<string, any>);
}

/** Execute one named strict v3 object request and return its provider response too. */
export async function runBrainV3Structured<T>(
  name: string,
  contents: unknown,
  schema: Record<string, unknown>,
  options: BrainV3SpecialistOptions,
  generator: BrainV3StructuredGenerator = generateContent
): Promise<{ value: T; response: any }> {
  if (brainV3SpecialistCircuitOpen()) throw new Error("brain_v3_specialist_circuit_open");
  const { timeoutMs, maxOutputTokens = 1_200, reasoning = "low", teen = false, ...config } = options;
  const request = brainV3StructuredRequest(name, contents, schema, {
    maxOutputTokens,
    openAIReasoningEffort: reasoning,
    ...config,
    ...safetyConfig(teen)
  });
  try {
    const response = await withTimeout(generator(request), timeoutMs, `Brain v3 ${name}`);
    const value = extractJsonObject(String(response?.text || ""));
    if (!completeTopLevelObject(value, schema)) {
      throw new Error(`Brain v3 ${name} returned an incomplete or non-strict result`);
    }
    specialistCircuitOpenUntil = 0;
    return { value: value as T, response };
  } catch (error) {
    specialistCircuitOpenUntil = Math.max(specialistCircuitOpenUntil, Date.now() + specialistFailureCooldownMs(error));
    throw error;
  }
}
