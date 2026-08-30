# Taki Brain v2 rollout

Brain v2 is a versioned understanding and answer pipeline. It keeps the existing
planner as the live default until an operator changes the server environment.

## Safety defaults

- `TAKI_BRAIN_VERSION=legacy` (or unset): existing users receive the legacy
  planner; Brain v2 is not called.
- `TAKI_BRAIN_VERSION=shadow`: Brain v2 runs only for a stable sample of
  installations and its result is discarded. Shadow calls run in an isolated
  meter, so they never change a user's credit charge or response.
- `TAKI_BRAIN_SHADOW_PERCENT=5` controls the shadow sample. Use a higher value
  only during a controlled staging pass; `100` requires a device id for live
  requests and is intended for explicit verification.
- `TAKI_BRAIN_VERSION=canary` assigns a stable per-installation sample using
  `TAKI_BRAIN_V2_PERCENT` (0–100). A device never changes brains because its
  wording changed, and anonymous requests remain legacy until the percentage is
  100.
- `TAKI_BRAIN_VERSION=v2` enables Brain v2 for all requests. Roll back by
  setting `TAKI_BRAIN_VERSION=legacy`; no client update or data migration is
  required.

## Verification gates

Run these checks before changing the live environment:

```sh
npm run typecheck
npm test
```

The `/health` response reports the selected mode, canary percentage, and
PII-free process-local counters (including repairs, safety overrides, streaming
answers, and cumulative shadow latency). Inspect those counters during
shadow/canary operation; they never contain transcript text, account ids, or
device ids.

Recommended sequence: run shadow in staging, review planner/action/research /
clarification rates and provider failures, enable a small canary, compare the
same installation's behavior against the legacy fallback, then increase the
percentage gradually. Keep the legacy mode available until action audits,
current-information routing, voice streaming, and client compatibility have
been verified at each step.
