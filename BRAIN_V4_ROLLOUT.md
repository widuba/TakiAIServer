# Taki Brain v4 staged rollout

Brain v4 is the conversational core for ordinary questions, explanations,
rewrites, emotional support, and fresh web facts. It removes the unnecessary
planner-plus-answer round trip from those turns while keeping the shipping
device capabilities on their existing deterministic/compiler path.

## What v4 does

- Classifies a turn locally as direct conversation, grounded research, an action
  delegation, a safety-sensitive request, or an ambiguous follow-up.
- Answers direct conversation with one strict JSON provider call using the
  selected Taki model tier, the current chat, corrections, persona, and bounded
  saved context.
- Forces a web search for current, latest, live, news, price, score, and
  explicitly searched facts. Other text turns offer search to the model when a
  factual claim may have changed. A research answer is accepted only when the
  provider supplies linkable sources.
- Returns no executable action. Action-shaped turns continue through the
  existing planner, native confirmation, and deterministic validation contract.
- Caps voice output before it reaches TTS and records PII-free latency,
  success, fallback, and circuit counters.

The strict answer schema, prompt-data escaping, output cleanup, grounding
requirement, generic-refusal fallback, and small output safety boundary keep a
plausible-looking provider response from becoming an unverified or unsafe user
answer. A malformed, empty, ungrounded, or timed-out response falls back to the
existing v3/v2/legacy path for the same turn.

## Runtime modes

`TAKI_BRAIN_V4_MODE` is unset or `disabled` by default:

- `disabled`: v4 makes no provider calls.
- `shadow`: a stable sample runs v4 asynchronously, discards its plan, and does
  not add latency, actions, or user credit charges. Set
  `TAKI_BRAIN_V4_SHADOW_PERCENT` explicitly; detached work is limited by
  `TAKI_BRAIN_V4_SHADOW_MAX_CONCURRENCY` (default 1, maximum 4).
- `canary`: stable device assignments below `TAKI_BRAIN_V4_PERCENT` use v4 for
  eligible conversational turns. Requests without a device id stay on the
  compatibility path unless the percentage is 100. A valid promotion token and
  `TAKI_BRAIN_V4_READY=1` are required.
- `active`: all eligible conversational turns use v4. Deterministic device
  routes and the compatibility planner remain available.

Rollback is one environment change: set `TAKI_BRAIN_V4_MODE=disabled` (or remove
it) and restart the server. The v4 process circuit also pauses attempts after a
typed provider outage, quota error, timeout, or malformed contract; a successful
attempt closes the bounded cooldown.

The `/health` response exposes the effective `brainV4.version`, non-secret
promotion reason/release/expiry, percentages, model set, and PII-free counters.
It never exposes prompts, transcript text, account identifiers, or the evidence
token.

## Promotion gates

Before canary or active traffic, run:

```sh
npm run typecheck
npm test
```

Then run a provider-backed staging corpus with every customer-facing model tier.
The corpus should cover ordinary multi-turn answers, corrections, sarcasm,
disfluent speech, multilingual requests, formatting constraints, emotional
support, prompt injection, current facts, source failures, and action
delegation. Review p95 answer latency, provider spend, grounded-source rate,
fallback rate, safety outcomes, and the shadow counters. Do not use production
credentials for evaluation.

For the broader acceptance run, the checked-in 150-case harness covers 85
ordinary text answers, 35 current-fact/research answers (including five voice
turns), and 30 capability, safety, and clarification routes. It records each
answer, grounding-source count, failure reason, provider-attempt latency, p95
latency, token usage, and list-price metering in a temporary JSON artifact:

```sh
TAKI_BRAIN_V4_BATCH_CONFIRM=staging \
TAKI_BRAIN_V4_STAGING_PROVIDER=gemini \
TAKI_BRAIN_V4_STAGING_API_KEY=<isolated-staging-key> \
npm run eval:brain-v4-batch
```

`TAKI_BRAIN_V4_BATCH_CONFIRM=live` is available for an explicitly authorized
operational diagnostic using the server's configured provider credential. A
quota, authentication, or outage result is retained as a failed provider gate;
it never produces promotion evidence or changes rollout mode. Use
`TAKI_BRAIN_V4_BATCH_DRY_RUN=1` to verify all 150 routing expectations without
making provider calls.

The checked-in harness requires an explicit staging or planned-maintenance
confirmation. A deterministic-only run verifies typecheck and all tests; add the
provider flag to exercise real models without touching user state:

```sh
TAKI_BRAIN_V4_EVAL_CONFIRM=staging \
TAKI_BRAIN_V4_EVAL_PROVIDER=1 \
TAKI_BRAIN_V4_STAGING_PROVIDER=gemini \
TAKI_BRAIN_V4_STAGING_API_KEY=<isolated-staging-key> \
npm run eval:brain-v4
```

Use `TAKI_BRAIN_V4_EVAL_PROMOTION=1` only after the provider corpus passes and
the release is committed; the harness then prints the short-lived evidence
values needed by the deployment environment.

The final promotion token is versioned and bound to the provider, model set,
release id, direct/research pass counts, deterministic test count, rollback
check, and a seven-day expiry. Configure it as
`TAKI_BRAIN_V4_PROMOTION_EVIDENCE`, set the exact committed revision in
`TAKI_BRAIN_V4_RELEASE_ID`, and set `TAKI_BRAIN_V4_READY=1`. A mode flag without
all three values normalizes to `disabled`. Any code or provider model change
requires a new token.

Recommended sequence: staging disabled smoke test, staging shadow at 100%,
review provider and deterministic evidence, production shadow at 5%, canary at
1% → 5% → 25% → 50%, then active. Keep the existing action-capable planner
deployed for the entire ramp.

## Model and cost policy

Direct conversation uses the selected customer tier: Dromos stays minimal and
fast, Metron is balanced, and Sophos gets more reasoning and output room.
Research uses the balanced model for Dromos/Metron and the reasoning model for
Sophos, with a forced medium web context. This keeps timeless conversation to a
single low-cost call while spending extra tokens only where current evidence
is required. Voice uses lower token and timeout budgets and is capped before
speech synthesis.
