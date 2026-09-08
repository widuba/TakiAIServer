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

## v23 verification — September 8, 2026

## v26 verification — September 8, 2026

The v26 multilingual boundary pass fixed a real routing gap: common Spanish,
French, German, Chinese, and Japanese safety requests, private actions, and
current-fact questions were previously falling through to ordinary English
conversation. Narrow language-aware guards now route those cases to safety,
native actions, or grounded research while leaving ordinary multilingual chat
direct. The focused multilingual regressions and complete deterministic gates
pass.

The v26 evidence passes 396/396 server tests, 6,000/6,000 classifier cases,
18,000/18,000 all-tier contracts, 500/500 long-chat cases, 144/144
action-matrix cases, and 150/150 canonical routing cases. The real provider
gate remains closed until a successful quota-backed provider run exists.

Commit `e2eb935` is pushed to `origin/main`. Render health serves
`2026-09-08-taki-3.0-staged-v26` with OpenAI selected and Taki 3.0 detached in
shadow mode (`canaryPercent: 0`, `shadowPercent: 1`, `promotionReady: false`,
`reason=readiness_flag_missing`, `liveUserImpact=none`).

## v25 verification — September 8, 2026

The v25 adversarial pass closed a precedence regression introduced by the v24
creative-generation rule: private phrases such as “find examples in my chat
history,” “find names for my contacts,” and “find options on my calendar” now
always remain on the native private-data path. The focused regression, full
suite, typecheck, and all deterministic promotion corpora pass.

The v25 evidence passes 395/395 server tests, 6,000/6,000 classifier cases,
18,000/18,000 all-tier contracts, 500/500 long-chat cases, 144/144
action-matrix cases, and 150/150 canonical routing cases. The live provider
gate remains unchanged and closed until a successful quota-backed provider run
exists.

Commit `b102ad2` is pushed to `origin/main`. Render health serves
`2026-09-08-taki-3.0-staged-v25` with OpenAI selected and Taki 3.0 detached in
shadow mode (`canaryPercent: 0`, `shadowPercent: 1`, `promotionReady: false`,
`reason=readiness_flag_missing`, `liveUserImpact=none`).

## v24 verification — September 8, 2026

The v24 conversational edge pass fixed six additional gaps found by a fresh
manual probe: creative “find” requests stay direct instead of becoming web
searches, recalling the chat stays direct even with date words such as
“yesterday,” private conversation and chat-history searches use the native
device path, personal advice such as “what should I eat tonight?” stays
conversation, subject-less “tell me something current/recent” requests ask
for a topic, and polite “maybe handle that” follow-ups preserve clarification.
The targeted regressions and complete 6,000-case sweep pass.

The v24 server suite passes 395/395, TypeScript typecheck passes, and
`git diff --check` is clean. Deterministic evidence passes 6,000/6,000
classifier cases (p50 0.251 ms, p95 0.414 ms), 18,000/18,000 all-tier strict
contracts (aggregate p50 0.276 ms, p95 0.564 ms), 500/500 long-chat cases with
1,502 history turns (p50 1.064 ms, p95 1.699 ms), 144/144 action-matrix cases,
and 150/150 canonical routing cases. Artifacts:
`/tmp/taki3-6000-followup.json`, `/tmp/taki3-contract-6000-followup.json`,
`/tmp/taki3-long-chat-1788876800348.json`, and
`/tmp/taki3-150-routing-followup.json`.

This source-only pass does not change the live-provider result: a provider
smoke still needs a successful, quota-backed request before promotion. The
release remains shadow-only until the provider quality, p95, cost, and
rollback evidence token is issued for the committed release.

Commit `f37c6d8` is pushed to `origin/main`. Render health now serves
`2026-09-08-taki-3.0-staged-v24` with OpenAI selected, Taki 3.0 in detached
shadow mode (`canaryPercent: 0`, `shadowPercent: 1`, `promotionReady: false`,
`reason=readiness_flag_missing`, `liveUserImpact=none`).

The v23 edge pass closes five additional routing gaps found by the 148-case
natural-language sweep: definitions containing a word such as “current” stay
timeless, private chat searches use the device search action, appointment
rescheduling reaches the calendar action compiler, song identification stays
on the native media path, and short filler-only or state-changing follow-ups
ask for context. The corrected edge corpus passes 148/148. The full server
suite passes 394/394, TypeScript typecheck passes, and `git diff --check` is
clean.

The v23 deterministic evidence passes 6,000/6,000 classifier cases (p50 0.257
ms, p95 0.437 ms), 18,000/18,000 all-tier strict contracts (aggregate p50
0.275 ms, p95 0.553 ms), 500/500 long-chat cases with 1,502 history turns (p50
1.074 ms, p95 1.811 ms), 144/144 action-matrix cases, and 150/150 canonical
routing cases. Artifacts: `/tmp/taki3-6000-1788876015594.json`,
`/tmp/taki3-contract-6000-1788876020245.json`,
`/tmp/taki3-long-chat-1788876014224.json`, and
`/tmp/taki3-150-routing-regression-v23-final.json`.

The post-deployment v23 live smoke reached Gemini for all eight provider-
eligible cases, but all eight returned typed HTTP 429 `ai_quota`; the four
local safety/clarification/delegation cases passed 4/4. Provider p50 was
118.321 ms, p95 262.016 ms, and measured cost was $0.00 because no provider
request succeeded. Artifact: `/tmp/taki3-live-smoke-1788876194506.json`.
Render health verifies `2026-09-08-taki-3.0-staged-v23` with OpenAI selected,
Taki 3.0 in detached shadow mode, `canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, and `liveUserImpact: none`. Promotion remains closed
until a successful provider-backed evidence package exists.

## v22 verification — September 8, 2026

The v22 routing pass fixes four natural-language boundary defects found by an
independent edge sweep. Conceptual questions such as “How does my calendar
work?” stay conversational, while actual private lookups such as “What are my
reminders?” remain device actions. Plain “Get directions…” commands now reach
the native maps handoff, vague follow-ups keep their clarification state after
“Hey” or “Please,” and a subject-less “What is the latest?” asks for the
missing topic instead of issuing an ungrounded web search. The full server
suite passes 392/392, typecheck passes, and `git diff --check` is clean.

The v22 deterministic evidence passes 6,000/6,000 classifier cases (p50 0.258
ms, p95 0.450 ms), 18,000/18,000 all-tier strict contracts (aggregate p50
0.281 ms, p95 0.564 ms), 500/500 long-chat cases with 1,502 history turns (p50
1.114 ms, p95 1.981 ms), 144/144 action-matrix cases, and 150/150 canonical
routing cases. Artifacts: `/tmp/taki3-6000-1788875603007.json`,
`/tmp/taki3-contract-6000-1788875607740.json`,
`/tmp/taki3-long-chat-1788875601671.json`, and
`/tmp/taki3-150-routing-regression-v22.json`.

The post-deployment authenticated live-provider smoke reached Gemini for all
eight provider-eligible cases, but all eight returned typed HTTP 429 `ai_quota`;
the four local safety/clarification/delegation cases passed 4/4. Provider p50
was 127.084 ms, p95 266.401 ms, and measured cost was $0.00 because no
provider request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788875748331.json`. No successful provider call means
no defensible live quality or cost measurement; the promotion gate remains
closed. Production is configured for OpenAI, but no production OpenAI
credential is available locally.

The v22 source is staged for deployment as
`2026-09-08-taki-3.0-staged-v22`; Taki 3.0 remains in detached shadow mode
until a successful provider-backed promotion evidence package exists.

## v21 verification — September 8, 2026

The v21 safety pass added coverage for explosive and weapon construction,
poisoning, stalking, fraud, identity theft, intrusion, DDoS, sabotage,
self-harm, overdose, and severe bleeding. It also verifies that prevention,
authorized security testing, safe handling, historical discussion, and clearly
fictional framing remain answerable. The targeted safety corpus passes 76/76;
the full server suite passes 390/390.

TypeScript typecheck and `git diff --check` pass. The latest deterministic
evidence passes 6,000/6,000 classifier cases (p50 0.574 ms, p95 1.347 ms),
18,000/18,000 all-tier strict contracts (aggregate p50 0.596 ms, p95 2.056
ms), 500/500 long-chat cases with 1,502 history turns (p50 2.249 ms, p95
5.216 ms), 144/144 action-matrix cases, and 150/150 canonical routing cases.
Artifacts: `/tmp/taki3-6000-1788874967744.json`,
`/tmp/taki3-contract-6000-1788874979813.json`,
`/tmp/taki3-long-chat-1788874964324.json`, and
`/tmp/taki3-150-routing-regression-v21.json`.

The authenticated live-provider smoke before deployment reached Gemini for all
eight provider-eligible cases, but all eight returned typed HTTP 429 `ai_quota`;
the four local safety/clarification/delegation cases passed 4/4. Provider p50
was 120.847 ms, p95 284.439 ms, and measured cost was $0.00 because no
provider request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788875008628.json`. Production health is configured
for OpenAI, but no production OpenAI credential is available locally, so the
real-provider quality and cost gate remains closed.

Commit `fa670a1` is pushed to `origin/main`. Render serves
`2026-09-07-taki-3.0-staged-v21` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).

## v20 verification — September 7, 2026

The v20 release adds a committed 40-case coverage corpus drawn from the
independent fuzz sweep. It covers direct explanations and transformations,
fresh public facts, private device lookups and mutations, cyber and medical
safety boundaries, and clarification follow-ups. The deterministic promotion
evaluator now passes with 388 tests, zero failures, typecheck passing, and a
clean worktree at release `f2b84d0`.

The final v20 deterministic evidence passes 6,000/6,000 classifier cases (p50
0.266 ms, p95 0.468 ms), 18,000/18,000 all-tier strict contracts (aggregate
p50 0.279 ms, p95 0.566 ms), 500/500 long-chat cases with 1,502 history turns
(p50 1.190 ms, p95 2.122 ms), 144/144 action-matrix cases, and 150/150
canonical routing cases. The independent natural-language fuzz corpus remains
190/190. Artifacts: `/tmp/taki3-6000-1788833012854.json`,
`/tmp/taki3-contract-6000-1788833017492.json`,
`/tmp/taki3-long-chat-1788833011450.json`, and
`/tmp/taki3-150-routing-regression-v20.json`.

The final authenticated live-provider smoke reached Gemini for all eight
provider-eligible cases, but all eight returned typed HTTP 429 `ai_quota`; the
four local safety/clarification/delegation cases passed 4/4. Provider p50 was
113.411 ms, p95 273.228 ms, and measured cost was $0.00 because no provider
request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788833035951.json`. Production health is configured
for OpenAI, but the local environment has no production OpenAI credential, so
the real-provider quality and cost gate remains closed.

Commit `f2b84d0` is pushed to `origin/main`. Render serves
`2026-09-07-taki-3.0-staged-v20` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).

## v19 verification — September 7, 2026

An independent 190-case conversational/action fuzz corpus found two additional
defects: vague polite follow-ups such as “Would you handle that?” could fall
through to ordinary conversation, and the verb “phish” was not covered by the
cyber-safety classifier. Taki 3.0 now preserves the clarification boundary,
catches phishing facilitation, and routes questions about the next public
eclipse, meteor shower, comet, or rocket launch through current research. The
corrected fuzz corpus passes 190/190.

The complete server suite passes 348/348 on two consecutive runs, TypeScript
typecheck passes, and `git diff --check` is clean. The refreshed deterministic
evidence passes 6,000/6,000 classifier cases (p50 0.302 ms, p95 0.519 ms),
18,000/18,000 all-tier strict contracts (aggregate p50 0.299 ms, p95 0.598
ms), 500/500 long-chat cases with 1,502 history turns (p50 1.278 ms, p95
2.086 ms), 144/144 action-matrix cases, and 150/150 canonical routing cases.
Artifacts: `/tmp/taki3-6000-1788832546851.json`,
`/tmp/taki3-contract-6000-1788832551534.json`,
`/tmp/taki3-long-chat-1788832545246.json`, and
`/tmp/taki3-150-routing-regression-v19.json`.

The authenticated live-provider smoke reached Gemini for all eight
provider-eligible cases, but all eight returned typed HTTP 429 `ai_quota`; the
four local safety/clarification/delegation cases passed 4/4. Provider p50 was
131.664 ms, p95 541.298 ms, and measured cost was $0.00 because no provider
request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788832587266.json`. Production health is configured
for OpenAI, but the local environment has no production OpenAI credential, so
the real-provider quality and cost gate remains closed.

The account-deletion test was also made concurrency-safe: it now asserts that
deleted identities stay absent while unrelated concurrent test registrations
are allowed. This removed a shared-store test race without weakening the
privacy invariant.

Commit `d76401f` is pushed to `origin/main`. Render serves
`2026-09-07-taki-3.0-staged-v19` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).

## v18 verification — September 7, 2026

The v18 pass added a second 56-case conversational/action sweep after the
v17 fixes. It caught and corrected natural follow-ups such as “Can you do
that?”, “Yes, please,” “What reminders do I have?”, “Find photos of my dog,”
personal battery/health lookups, reminder edits, and “What did you just do?”
history questions. The expanded sweep now passes 56/56; together with the
earlier sweep, the additional natural-language coverage is 146/146.

The complete server suite passes 348/348, TypeScript typecheck passes, and
`git diff --check` is clean. The refreshed deterministic evidence passes
6,000/6,000 classifier cases (p50 0.253 ms, p95 0.428 ms), 18,000/18,000
all-tier strict contracts (aggregate p50 0.273 ms, p95 0.548 ms), 500/500
long-chat cases with 1,502 history turns (p50 1.110 ms, p95 1.838 ms),
144/144 action-matrix cases, and 150/150 canonical routing cases. Artifacts:
`/tmp/taki3-6000-1788831920002.json`,
`/tmp/taki3-contract-6000-1788831924668.json`,
`/tmp/taki3-long-chat-1788831918690.json`, and
`/tmp/taki3-150-routing-regression-v18.json`.

The authenticated live-provider smoke reached the configured Gemini test
account for all eight provider-eligible cases, but every call returned typed
HTTP 429 `ai_quota`; the four local safety/clarification/delegation cases
passed 4/4. Provider p50 was 136.545 ms, p95 259.323 ms, and measured cost
was $0.00 because no provider request succeeded. Artifact:
`/tmp/taki3-live-smoke-1788832036325.json`. Production health is configured
for OpenAI, but no production OpenAI credential is available in this local
environment, so this result does not claim provider answer quality or cost.
The real-provider promotion gate remains closed.

Commit `c80c327` is pushed to `origin/main`. Render serves
`2026-09-07-taki-3.0-staged-v18` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).

## v17 verification — September 7, 2026

The v17 pass came from an additional 90-case natural-language sweep. It fixed
generic reminder/calendar advice being treated as a private lookup, instructional
“How do I …?” questions being treated as actions, example/template requests
starting an action path, Japan border-regulation wording missing fresh research,
and undo/recent-activity questions falling through to a provider. The expanded
sweep now passes 90/90.

The complete server suite passes 348/348 and TypeScript typecheck passes. The
refreshed deterministic evidence passes 6,000/6,000 classifier cases (p50
0.265 ms, p95 0.534 ms), 18,000/18,000 all-tier strict contracts (aggregate
p50 0.287 ms, p95 0.580 ms), 500/500 long-chat cases with 1,502 history turns
(p50 1.193 ms, p95 2.968 ms), 144/144 action-matrix cases, and 150/150
canonical routing cases. Artifacts: `/tmp/taki3-6000-1788831185463.json`,
`/tmp/taki3-contract-6000-1788831190151.json`,
`/tmp/taki3-long-chat-1788831184026.json`, and
`/tmp/taki3-150-routing-regression-v17.json`.

The final v17 authenticated live smoke again reached Gemini but all 8
provider-eligible cases returned typed HTTP 429 `ai_quota`; the 4 local
safety/clarification/delegation cases passed. Provider p50 was 119.885 ms,
p95 250.837 ms, and measured cost was $0.00 because no provider request
succeeded. Artifact: `/tmp/taki3-live-smoke-1788831377446.json`. The real
provider gate remains closed.

Commit `082f032` is pushed to `origin/main`. Render serves
`2026-09-07-taki-3.0-staged-v17` with OpenAI selected and Taki 3.0 still in
detached shadow mode (`canaryPercent: 0`, `shadowPercent: 1`,
`promotionReady: false`, `reason=readiness_flag_missing`,
`liveUserImpact=none`).
