/**
 * The `RateLimit-*` response headers for agent budgets (#646). Kept apart
 * from rate-budget.ts, which tests often mock wholesale, so routes can always
 * add the headers.
 */

/** Which budget a request was charged to: writes change the board, reads only look. */
type BudgetKind = "read" | "write";

/**
 * What a charge says about the budget it was taken from (#646). `remaining`
 * and `resetSeconds` come from the store's own check, so reporting them costs
 * no extra read or write; a store or test double that doesn't report them
 * just leaves them out.
 */
export type AgentBudgetQuota = {
  kind?: BudgetKind;
  limit?: number;
  windowSeconds?: number;
  remaining?: number;
  resetSeconds?: number;
};

/**
 * The IETF draft `RateLimit-*` fields for one budget (#646): its limit, what's
 * left and when it resets (seconds from now), the policy (`30;w=3600`), and
 * which budget it is, since reads and writes are counted apart. Only the
 * calling agent's own budget is ever described.
 */
export function agentBudgetHeaders(budget: AgentBudgetQuota): Record<string, string> {
  const headers: Record<string, string> = {};
  if (budget.kind) headers["RateLimit-Budget"] = budget.kind;
  if (typeof budget.limit === "number") {
    headers["RateLimit-Limit"] = String(budget.limit);
    if (typeof budget.windowSeconds === "number") headers["RateLimit-Policy"] = `${budget.limit};w=${budget.windowSeconds}`;
  }
  if (typeof budget.remaining === "number") headers["RateLimit-Remaining"] = String(budget.remaining);
  if (typeof budget.resetSeconds === "number") headers["RateLimit-Reset"] = String(budget.resetSeconds);
  return headers;
}

/** Adds the budget's `RateLimit-*` headers to a response, in place. */
export function withAgentBudgetHeaders<T extends Response>(response: T, budget: AgentBudgetQuota): T {
  for (const [name, value] of Object.entries(agentBudgetHeaders(budget))) response.headers.set(name, value);
  return response;
}

