# Billing and dual-credit operations

The server is authoritative for subscription entitlements and balances. `src/credits.ts` contains the shared plan catalog, variable AI-credit charging, Voice Credit rules, grant ledger, usage ledger, lifecycle state, and legacy migration. `src/iap.ts` verifies Apple transactions and notifications; `index.ts` handles App Store and Stripe lifecycle events.

`src/productKnowledge.ts` turns that same catalog and the user's live `CreditSummary` into Taki's customer-facing answers. Pricing, balance, renewal, cancellation, upgrade, and credit questions must use this layer rather than duplicating plan values in a model prompt or route.

## Plans

| Internal tier | Customer name | Price | AI Credits | Voice Credits |
| --- | --- | ---: | ---: | ---: |
| `plus` | Plus | $9.99/month | 4,000 | 50 |
| `plus_voice` | Premium | $14.99/month | 6,000 | 300 |
| `pro` | Pro | $24.99/month | 12,000 | 600 |

The `plus_voice` internal key and `com.davidwiduba.takiai.sub.plusvoice.monthly` product ID are intentionally retained for existing subscribers. All customer-facing surfaces call it Premium.

Every request uses the existing variable AI Credit calculation. Voice additionally uses one Voice Credit when available; otherwise it uses 40 extra AI Credits. The complete deduction is performed in one locked ledger update. Production requires `DATABASE_URL`, which enables a Postgres `SELECT ... FOR UPDATE` transaction. File persistence is for local development only.

## Grant and lifecycle behavior

- A verified new period grants the plan AI allowance and resets Voice Credits to the plan allowance. AI grants retain the existing 90-day expiry/rollover policy; purchased top-ups remain separate.
- The provider period key is the idempotency key. Duplicate receipt validation, restore, webhook, and notification events do not grant twice.
- A mid-cycle upgrade changes the entitlement immediately and adds only the Voice Credit allowance difference. It does not create a second AI grant. A downgrade takes effect with the next successfully verified period.
- Cancellation, billing retry, and grace preserve the current entitlement through the provider period end.
- Expiration moves the account to Free and clears Voice Credits while leaving already-paid AI grants to their existing expiry.
- Refund/revocation removes unused subscription AI grants and Voice Credits but preserves purchased top-ups.
- Events with an older period end cannot overwrite a newer entitlement.

Legacy accounts migrate lazily and transactionally on first ledger access. Existing AI grants and purchased top-ups are not changed. A legacy `plus_voice` account remains internally `plus_voice`, displays as Premium, and receives `max(existing voice balance, 300 - legacy voice usage)` Voice Credits for its current cycle.

## Environment and deployment

Required production billing configuration:

```text
DATABASE_URL=<durable Postgres connection URL>
APP_APPLE_ID=<numeric App Store Connect app ID>
IAP_PLUS_PRODUCT_ID=com.davidwiduba.takiai.sub.plus.monthly
IAP_PREMIUM_PRODUCT_ID=com.davidwiduba.takiai.sub.plusvoice.monthly
IAP_PRO_PRODUCT_ID=com.davidwiduba.takiai.sub.pro.monthly
STRIPE_SECRET_KEY=<Stripe secret key, when web billing is enabled>
STRIPE_WEBHOOK_SECRET=<Stripe endpoint signing secret>
WEB_BASE_URL=https://takiai.app
```

Never set `IAP_ALLOW_UNVERIFIED=1` in production. Configure App Store Server Notifications V2 to the existing `/api/iap/notifications` endpoint and Stripe events to `/api/stripe/webhook`.

The local `Taki.storekit` configuration is updated for Xcode testing, but live subscription display names, prices, and descriptions must also be changed in App Store Connect. Preserve the existing product IDs. Stripe prices are created server-side from the catalog, so deploy the server before exposing the updated web pricing.

No SQL schema migration is required: the existing `kv` table stores versioned JSON ledgers. The safe migration is performed under the same row lock used for charging and is persisted when the account is read.
