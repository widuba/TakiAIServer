import { CreditLedgerOverdraftError, InsufficientCreditsError } from "./credits.js";
import { suspendForCreditIntegrity } from "./safety.js";

// Called only after a request has actually consumed provider work. If its final
// metered cost is no longer covered by the user's grants, that is real usage
// beyond the account's allocation and must be reviewed. Normal preflight
// insufficiency never reaches this path and remains a paywall, not a suspension.
export async function suspendOnUnfundedUsageCharge(identity: string, error: unknown): Promise<boolean> {
  if (!(error instanceof CreditLedgerOverdraftError) && !(error instanceof InsufficientCreditsError)) return false;
  await suspendForCreditIntegrity(identity);
  return true;
}
