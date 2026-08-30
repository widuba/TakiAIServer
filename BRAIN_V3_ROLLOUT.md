# Taki Brain v3 staged rollout

Brain v3 is a separate understanding, safety-policy, grounded-research, response, and action-compiler pipeline. It preserves the existing device action names and response envelope, but it does not run for customer traffic by default.

## Runtime modes

`TAKI_BRAIN_V3_MODE` is unset or `disabled` by default:

- `disabled`: no v3 provider call; the current planner is unchanged.
- `shadow`: a stable sample runs v3 asynchronously, including its strict research path, discards its plan, and does not add latency, actions, or user credit charges. `TAKI_BRAIN_V3_SHADOW_PERCENT` defaults to 0; set it explicitly to create shadow provider traffic.
- `canary`: only stable device assignments below `TAKI_BRAIN_V3_PERCENT` use v3. Requests without a device identity stay on the legacy path unless the percentage is 100. A valid, unexpired promotion token and `TAKI_BRAIN_V3_READY=1` are also required.
- `active`: all eligible model-driven turns use v3. A valid, unexpired promotion token and `TAKI_BRAIN_V3_READY=1` are also required. Deterministic device capability routes and the legacy fallback remain available.

The health endpoint exposes the effective `brainV3.version`, `brainV3.promotionReady`, a non-secret `brainV3.promotion` reason/release/expiry status, `brainV3.canaryPercent`, `brainV3.shadowPercent`, `brainV3.auxEnabled`, and bounded process-local counters. It never exposes user text, prompts, or the promotion token. Rollback is one environment change: set `TAKI_BRAIN_V3_MODE=disabled` (or remove it), then restart the service.

`TAKI_BRAIN_V3_SHADOW_MAX_CONCURRENCY` bounds detached shadow provider work to 1 by default (maximum 4). This protects the live provider from an accidental shadow stampede; use a separate staging provider project for evaluation.

### Planned maintenance cutover with the existing provider key

If a separately isolated provider project is unavailable but the operator has
explicitly approved using the existing backend credential during a planned
maintenance window, the normal evidence gate can be bypassed only through the
release-bound active maintenance override:

- `TAKI_BRAIN_V3_MODE=active`
- `TAKI_BRAIN_V3_READY=1`
- `TAKI_BRAIN_V3_RELEASE_ID=<current committed revision>`
- `TAKI_BRAIN_V3_MAINTENANCE_OVERRIDE=1`

This is intentionally active-only and does not enable auxiliary surfaces. Keep
the override for the maintenance window only, then replace it with evaluator
evidence or roll back to `disabled`. The service retains its bounded circuit
and compatibility fallback if a v3 provider attempt fails.

If an active or canary v3 request fails, the process-local v3 circuit opens for a bounded cooldown based on the typed provider error. Brain v3 requests are pinned to the provider/model named by the promotion evidence; they never silently cross-fail over to the legacy alternate provider. Subsequent eligible requests use the compatibility planner immediately until a successful v3 attempt closes it. This limits repeated latency and provider pressure during a bad rollout without changing the environment flag or touching deterministic device routes.

The auxiliary strict boundary has its own short circuit. A provider, timeout, unsupported-input, or malformed-contract failure immediately returns that surface to its compatibility implementation; later auxiliary attempts are skipped for a bounded cooldown instead of adding a second provider wait to every request.

## Promotion gates

Before enabling canary, run the server typecheck and test suite, then evaluate the versioned adversarial corpus in `tests/brainV3.test.ts` and a provider-backed staging run. Do not use production credentials for the corpus. Promote only when all of the following are true for the chosen staging window:

1. No schema, compiler, action-grounding, safety, or response-finalization failures.
2. No action is emitted for a refusal, ambiguous recipient, invented entity, or missing required detail.
3. Sarcastic, emotional, multilingual, and disfluent requests preserve the intended meaning without echoing the noise.
4. Current-fact requests use verified research; timeless questions do not get unnecessary refusals.
5. Shadow/canary provider failures fall back to the legacy planner without changing the user's action or billing result.
6. p95 latency, provider spend, error rate, and refusal overrides are reviewed from the staging health counters and provider billing telemetry.

The provider-backed gate is executable and staging-only by default. Configure an explicitly separate staging credential, then run `TAKI_BRAIN_V3_EVAL_CONFIRM=staging TAKI_BRAIN_V3_STAGING_PROVIDER=openai TAKI_BRAIN_V3_STAGING_API_KEY=... npm run eval:brain-v3` (use `gemini` only when that is the staging provider; optionally provide explicitly named staging organization/project/base-URL variables). During an explicitly approved planned maintenance window, the evaluator also supports `TAKI_BRAIN_V3_EVAL_CONFIRM=maintenance TAKI_BRAIN_V3_EVAL_USE_EXISTING_KEY=1` with the existing backend key passed through `TAKI_BRAIN_V3_STAGING_API_KEY`; this is logged as an operator choice and does not relax the production rollout evidence gate. The harness clears inherited provider routing, isolates the other provider, runs a fixed corpus covering noisy speech, contextual and explicit sarcasm, actions, clarification, safety, prompt injection, research routing, and corrections, logs only case ids and bounded metrics, exits nonzero on any failed expectation, and never executes an action or charges a user. The core corpus runs once under every customer-facing response tier, while the dedicated Brain v3 model is exercised for understanding and policy on every run; the promotion token records the complete provider model set. In addition to checking the final answer, the core corpus checks the non-user-facing semantic snapshots for signals, understanding, and policy, so a topical-looking answer cannot hide a missed stutter, sarcasm cue, language, correction, intent, or safety decision. By default, research is a deterministic fixture for repeatability. Add `TAKI_BRAIN_V3_EVAL_AUX=1` to the same command for the additional provider-backed strict-contract corpus covering recipes, day plans, durable memory, titles, contextual safety, summaries, event/venue extraction, time/math parsing, style rewriting, web answers, and tracker snapshots; those cases use synthetic inputs and are never written to a user's account or device. Before promotion, run the core corpus once more with `TAKI_BRAIN_V3_EVAL_REAL_WEB=1`; that opt-in staging-only mode uses one fixed current-fact request against the provider's real web-search path and requires linkable sources. A successful run is necessary but not sufficient: review both provider billing/latency windows and deterministic suite before promotion.

For the final machine-checked gate, run the same evaluator with `TAKI_BRAIN_V3_EVAL_PROMOTION=1`, `TAKI_BRAIN_V3_EVAL_AUX=1`, and `TAKI_BRAIN_V3_EVAL_REAL_WEB=1`. Promotion mode requires a clean committed worktree, including no untracked files, runs typecheck plus the complete deterministic suite itself, requires every core-and-tier case, auxiliary case, and real-web case to pass, and performs an in-process rollback rehearsal that proves disabling v3 clears every core, auxiliary, canary, and shadow selector. It then prints one short-lived, base64url promotion token containing only the release/provider/model-set identity, bounded pass metrics, and timestamps—never prompts, model output, account data, or credentials. It never writes account/device state. Copy that token into the deployment secret/configuration as `TAKI_BRAIN_V3_PROMOTION_EVIDENCE`, set `TAKI_BRAIN_V3_RELEASE_ID` to the exact committed revision printed by the evaluator, and set `TAKI_BRAIN_V3_READY=1`; without all three values, active/canary normalize to disabled. The token expires after seven days and is bound to the configured provider, model set, and release id, so code or provider changes require a fresh gate.

Suggested sequence: staging disabled smoke test → staging shadow with `TAKI_BRAIN_V3_SHADOW_PERCENT=100` → review the corpus and real anonymized aggregate metrics → production shadow with `TAKI_BRAIN_V3_SHADOW_PERCENT=5` → run the final promotion gate → set the matching release id, evidence token, and readiness flag → canary at 1% → 5% → 25% → 50% → 100% active. Keep the legacy path deployed throughout the ramp and pause/rollback on any gate failure. Clear the readiness flag and promotion evidence as part of rollback.

The recipe generator/import extractor, day-plan generator, durable-memory extractor, URL summarizer, photo vision route, attachment-analysis route, contextual safety reviewer, chat-title generator, event matching, venue inference, math/time parsing, style rewrite, and live tracker fallbacks have a second opt-in boundary: `TAKI_BRAIN_V3_AUX_MODE=active`. It is ignored unless the core mode is already `active` (or `v3`) and the same valid promotion evidence is present. Leave it unset during core canary and enable it only after the same staging corpus plus auxiliary contract tests and a no-write rollback rehearsal pass. Removing the auxiliary flag returns those surfaces to their legacy requests without changing the core mode. Generic current-fact and single/multi-event research are core v3 surfaces; they use their compatibility implementations only when the selected v3 request fails. Vision and attachment requests retain a compatibility fallback for provider-specific media limitations; current-data surfaces additionally require linkable grounding and deterministic entity/date checks.

## Model configuration

`OPENAI_BRAIN_V3_MODEL` and `GEMINI_BRAIN_V3_MODEL` tune the v3 understanding/policy model without changing the customer-selected answer tier. `OPENAI_API_KEY` stays backend-only. The OpenAI adapter uses Responses Structured Outputs for v3 JSON stages; Gemini receives the equivalent JSON schema at its provider boundary.
