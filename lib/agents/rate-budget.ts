import { NextResponse } from "next/server";
import {
  consumeRateLimit,
  RATE_LIMIT_MESSAGE,
  type RateLimitConfig,
} from "@/lib/rate-limit";
import { withAgentBudgetHeaders, type AgentBudgetQuota } from "@/lib/agents/rate-budget-headers";

export { agentBudgetHeaders, withAgentBudgetHeaders, type AgentBudgetQuota } from "@/lib/agents/rate-budget-headers";

/**
 * Per-agent read and write budgets (#440).
 *
 * Each agent has two sliding one-hour windows in the shared rate-limit store
 * (`RateLimitHit`, #296): `agent:{id}:write` and `agent:{id}:read`, so reads
 * never use up the write budget. A tenant admin can turn on `Agent.burst` for
 * an agent that files a lot of genuine findings.
 */

const HOUR = 60 * 60 * 1000;

/** What a request costs: writes change the board, reads only look at it. */
export type AgentBudgetKind = "read" | "write";

export const AGENT_RATE_BUDGETS = {
  standard: {
    write: { max: 30, windowMs: HOUR },
    read: { max: 600, windowMs: HOUR },
  },
  burst: {
    write: { max: 400, windowMs: HOUR },
    read: { max: 4000, windowMs: HOUR },
  },
} as const satisfies Record<"standard" | "burst", Record<AgentBudgetKind, RateLimitConfig>>;

/** The fields of `Agent` the budget needs. */
export type BudgetedAgent = { id: string; burst?: boolean | null };

export type AgentBudgetResult =
  | ({ allowed: true } & AgentBudgetQuota)
  | ({ allowed: false; retryAfterSeconds: number } & AgentBudgetQuota);

export function agentBudgetKey(agentId: string, kind: AgentBudgetKind): string {
  return `agent:${agentId}:${kind}`;
}

export function agentBudget(agent: BudgetedAgent, kind: AgentBudgetKind): RateLimitConfig {
  return AGENT_RATE_BUDGETS[agent.burst ? "burst" : "standard"][kind];
}

/**
 * Charges one request to the agent's read or write budget. Writes are create,
 * comment, bid, offer accept, validate and test verdict; reads are list,
 * get, feed and the event poll. Webhook delivery is not charged.
 */
export async function consumeAgentBudget(
  agent: BudgetedAgent,
  kind: AgentBudgetKind,
  now = Date.now(),
): Promise<AgentBudgetResult> {
  const config = agentBudget(agent, kind);
  const result = await consumeRateLimit(agentBudgetKey(agent.id, kind), config, now);
  const quota: AgentBudgetQuota = {
    kind,
    limit: config.max,
    windowSeconds: Math.round(config.windowMs / 1000),
    ...(typeof result.remaining === "number" ? { remaining: Math.max(0, result.remaining) } : {}),
    ...(typeof result.resetAfterMs === "number" ? { resetSeconds: Math.max(0, Math.ceil(result.resetAfterMs / 1000)) } : {}),
  };
  if (result.allowed) return { allowed: true, ...quota };
  // Retry-After is whole seconds; round up so a retry at that time succeeds.
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)), ...quota };
}

/**
 * The `429` an API route returns when an agent is over budget. It names the
 * exhausted budget and when it resets, in the body and the `RateLimit-*`
 * headers (#646), as well as `Retry-After`.
 */
export function agentBudgetExceededResponse(retryAfterSeconds: number, budget: AgentBudgetQuota = {}): NextResponse {
  const response = NextResponse.json(
    {
      error: RATE_LIMIT_MESSAGE,
      ...(budget.kind ? { budget: budget.kind } : {}),
      ...(typeof budget.limit === "number" ? { limit: budget.limit } : {}),
      resetSeconds: budget.resetSeconds ?? retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
  return withAgentBudgetHeaders(response, { remaining: 0, resetSeconds: retryAfterSeconds, ...budget });
}
