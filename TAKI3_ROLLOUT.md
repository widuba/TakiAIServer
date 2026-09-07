# Taki 3.0 rollout

Taki 3.0 is the single customer-facing conversational brain. It handles
ordinary conversation and current-fact answers through one strict answer
contract, while deterministic device routes and the compatibility action
compiler retain the native confirmation and validation rules.

The server exposes only `taki3` in `/health`. Compatibility code for
specialized action and extraction paths is part of the same Taki 3.0 boundary;
it is not a separate traffic surface.

The canonical rollout variables are:

- `TAKI_TAKI3_MODE=shadow|canary|active|disabled`
- `TAKI_TAKI3_PERCENT` for stable-device canary assignment
- `TAKI_TAKI3_SHADOW_PERCENT` for detached, unmetered shadow sampling
- `TAKI_TAKI3_READY=1`, `TAKI_TAKI3_RELEASE_ID`, and
  `TAKI_TAKI3_PROMOTION_EVIDENCE` for promotion evidence

Legacy numbered-brain rollout variables are ignored. A stale legacy flag
cannot revive an old traffic surface; only the Taki 3.0 variables below are
translated into the internal rollout gate. A mode alone never promotes traffic: the evidence token must
match the committed release, provider, model set, deterministic suite, live
provider suites, rollback check, and expiry window.

Rollback is `TAKI_TAKI3_MODE=disabled`. Provider quota, authentication,
timeout, and outage errors stop at the Taki 3.0 boundary so a single failed
turn cannot cascade through multiple planners and multiply latency or spend.

The 6,000-turn deterministic and structured-contract checks are available as:

```sh
npm run eval:taki3-6000
npm run eval:taki3-6000-contract
npm run eval:taki3-6000-all-models
npm run eval:taki3-long-chat
npm run eval:taki3-action-matrix
```

The all-model contract sweep repeats the complete 6,000-case corpus across
Dromos, Metron, and Sophos (18,000 fixture turns total). The long-chat audit
adds 500 varied turns with 1,500-history contexts, oversized turns, repeated
corrections, voice bounds, and the strict answer contract. These checks do not
certify vendor quality or live web grounding.
The action matrix runs 48 supported action families through the understanding,
policy, grounding, and validation boundary with three natural-language variants
per family (144 fixture-provider cases). The current run passes 144/144. Its
weekday reminder case uses the existing `weekly` recurrence contract and the
native weekday values; it does not add an unsupported recurrence kind.
The latest explicitly confirmed live smoke reached the configured Gemini
provider for 8 eligible cases, but all 8 returned typed HTTP 429 `ai_quota`
errors. The four local safety/clarification/delegation cases passed. Provider
p50 was 253.874 ms, p95 754.964 ms, and measured cost was $0.00 because no
provider request succeeded. Artifact: `/tmp/taki3-live-smoke-1788804235137.json`.
Promotion remains blocked until a real provider run has successful provider
calls and reports quality, p95 latency, and measured usage.

The compatibility compiler treats `identify_song` as a read-only action with
its own question cues. Requests such as “What song is playing right now?” stay
an on-device identification action when the compatibility brain serves the
turn instead of being downgraded to a generic answer. The regression suite
covers this path; the full server suite and 144-case action matrix remain
green.
