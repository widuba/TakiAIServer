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

The latest deterministic rerun passed 6,000/6,000 (p50 0.242 ms, p95 0.401
ms, max 111.043 ms), the three-tier contract sweep passed 18,000/18,000
(p50 0.267 ms, p95 0.462 ms, max 112.490 ms), and the long-chat audit passed
500/500 with 1,502 history turns (p50 1.011 ms, p95 1.762 ms, max 122.522 ms).
The action matrix passed 144/144 cases across 48 action families and three
natural-language variants per family. The complete server suite is 347/347
with typecheck passing.

The bounded live provider tier audit passed 9/9 checks across Dromos, Metron,
and Sophos, with aggregate p50 3,560 ms and p95 6,315 ms at 179 credits
($0.179 at the app's $0.001 credit rate). This audit exercised the deployed
legacy compatibility response path because the Taki 3.0 promotion gate remains
closed. It is live provider evidence for the compatibility path, not proof of
active Taki 3.0 traffic. The current health response reports v15, OpenAI, and
`promotionReady: false` with `readiness_flag_missing`.

The v15 routing patch also forces organization leadership questions such as
“Who runs OpenAI?”, “Who heads the FDA?”, and “Who is in charge of NASA?”
through current research, while leaving timeless phrases such as “Who runs the
marathon?” on the direct conversation path. The full intelligence regression
suite covers both sides of this boundary.

## v16 verification — September 7, 2026

The v16 routing patch expands live-fact detection for venue hours, open status,
local wait times, gas prices, weather, game times, sales, package status,
flight status, traffic rules, and travel-entry rules. It also covers natural
device-action phrasing such as “I was hoping you could call Mom,” “Take me to
the airport,” and location-aware food requests such as “Where should I eat in
my area?” Educational phrasing that mentions a capability (“explain how to
schedule a meeting”) remains ordinary conversation.

The final deterministic evidence passed 6,000/6,000 classifier cases (p50
0.260 ms, p95 0.437 ms, max 108.604 ms), 18,000/18,000 strict contract cases
across all three tiers (p50 0.275 ms, p95 0.551 ms, max 110.671 ms), 500/500
long-chat cases with 1,502 history turns (p50 1.098 ms, p95 1.856 ms, max
120.858 ms), 144/144 action-matrix cases, and 150/150 canonical routing cases.
Artifacts: `/tmp/taki3-6000-1788830506940.json`,
`/tmp/taki3-contract-6000-1788830511585.json`,
`/tmp/taki3-long-chat-1788830505574.json`, and
`/tmp/taki3-150-routing-regression-v16.json`. The complete server suite is
348/348 and TypeScript typecheck passes.

The final authenticated live smoke reached Gemini for all eight provider
eligible cases, but every provider call returned typed HTTP 429 `ai_quota`;
the four local safety, clarification, and delegation cases passed. Provider
p50 was 120.355 ms, p95 273.629 ms, and measured cost was $0.00 because no
provider request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788830648831.json`. The live provider gate therefore
remains closed; no quality or cost claim is inferred from fixture runs.

Commit `b1c2556` is pushed to `origin/main`. Render now serves
`2026-09-07-taki-3.0-staged-v16` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).
