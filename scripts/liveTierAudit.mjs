#!/usr/bin/env node

/**
 * Bounded, authenticated production audit for the three customer-facing tiers.
 * The exhaustive 6,000-case suites are deterministic contract tests; this file
 * is deliberately small so it can exercise the real provider without spending
 * an uncontrolled number of credits.
 *
 * Usage:
 *   node scripts/liveTierAudit.mjs <base-url> <device-id> <reset-epoch> <credential>
 */

const baseURL = process.argv[2] || "https://takiaiserver.onrender.com";
const deviceId = process.argv[3];
const resetEpoch = process.argv[4];
const credential = process.argv[5] || process.env.TAKI_DEVICE_CREDENTIAL || "";
const timeoutMs = Math.max(10_000, Math.min(90_000, Number(process.env.TAKI_LIVE_TIER_TIMEOUT_MS || 45_000)));

if (!deviceId || !resetEpoch || !credential) {
  console.error("Usage: node scripts/liveTierAudit.mjs <base-url> <device-id> <reset-epoch> <device-credential>");
  process.exit(2);
}

const tiers = [
  { model: "taki_2_0_swift", name: "Dromos" },
  { model: "taki_2_1", name: "Metron" },
  { model: "taki_2_1_reasoning", name: "Sophos" }
];

const prompts = [
  {
    id: "direct-explanation",
    message: "Explain compound interest like I'm 12, with one tiny example.",
    kind: "direct",
    check: (text) => /interest|grow|money/i.test(text) && text.length >= 80
  },
  {
    id: "direct-constraint",
    message: "Name exactly three benefits of walking. Use a numbered list, six words per item, and no introduction.",
    kind: "direct",
    check: (text) => {
      const items = String(text).split(/\r?\n/)
        .map((line) => line.match(/^\s*\d+[.)]\s+(.+)$/)?.[1] || "")
        .filter(Boolean);
      return items.length === 3 && items.every((item) => (item.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length === 6);
    }
  },
  {
    id: "research-ceo",
    message: "Who is currently the CEO of OpenAI? Verify it and cite the source.",
    kind: "research",
    check: (text, payload) => /ceo|sam altman/i.test(text) && Array.isArray(payload?.sources) && payload.sources.length > 0
  }
];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const rows = [];
for (const tier of tiers) {
  for (const prompt of prompts) {
    const requestId = `tier-audit-${tier.model}-${prompt.id}-${Date.now()}`;
    const started = Date.now();
    let status = 0;
    let payload = {};
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
      const response = await fetch(`${baseURL}/api/assistant`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taki-reset-epoch": resetEpoch,
          "x-taki-device-id": deviceId,
          "x-taki-device-credential": credential
        },
        body: JSON.stringify({
          message: prompt.message,
          deviceId,
          timeZone: "America/New_York",
          requestId,
          profile: { model: tier.model, characterStrength: 3, useMyName: 1 }
        }),
        signal: controller.signal
      });
      status = response.status;
      payload = await response.json();
    } catch (error) {
      payload = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    const text = String(payload?.spokenText || "");
    const sourceCount = Array.isArray(payload?.sources) ? payload.sources.length : 0;
    const ledgerCost = Number(payload?.credits?.cost ?? payload?.credits?.spent ?? 0);
    const ok = status === 200 && !!text.trim() && !/couldn't|could not|temporarily unavailable|try again/i.test(text)
      && prompt.check(text, payload);
    const row = {
      tier: tier.name,
      model: tier.model,
      id: prompt.id,
      kind: prompt.kind,
      ok,
      status,
      latencyMs,
      sourceCount,
      ledgerCost,
      error: payload?.error || null,
      text
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const providerRows = rows.filter((row) => row.status === 200 && row.ledgerCost > 0);
const latencies = providerRows.map((row) => row.latencyMs);
const byTier = Object.fromEntries(tiers.map((tier) => {
  const tierRows = rows.filter((row) => row.model === tier.model);
  const tierProviderRows = tierRows.filter((row) => row.ledgerCost > 0);
  return [tier.name, {
    total: tierRows.length,
    passed: tierRows.filter((row) => row.ok).length,
    failed: tierRows.filter((row) => !row.ok).length,
    p50LatencyMs: percentile(tierProviderRows.map((row) => row.latencyMs), 0.5),
    p95LatencyMs: percentile(tierProviderRows.map((row) => row.latencyMs), 0.95),
    credits: tierRows.reduce((sum, row) => sum + row.ledgerCost, 0)
  }];
}));

const summary = {
  total: rows.length,
  passed: rows.filter((row) => row.ok).length,
  failed: rows.filter((row) => !row.ok).length,
  providerRequests: providerRows.length,
  providerCredits: providerRows.reduce((sum, row) => sum + row.ledgerCost, 0),
  providerUsdAtLedgerRate: providerRows.reduce((sum, row) => sum + row.ledgerCost, 0) * 0.001,
  p50LatencyMs: percentile(latencies, 0.5),
  p95LatencyMs: percentile(latencies, 0.95),
  byTier,
  rows
};
console.log(JSON.stringify({ summary }));
process.exitCode = summary.failed ? 1 : 0;
