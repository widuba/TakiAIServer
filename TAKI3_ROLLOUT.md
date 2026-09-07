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
```

Those checks do not certify vendor quality or live web grounding. Promotion
remains blocked until a real provider run has successful provider calls and
reports quality, p95 latency, and measured usage.
