import { NextResponse, type NextRequest } from "next/server";
import { agentErrorResponse, requireAgent } from "@/lib/agents/require-agent";
import { agentBudgetExceededResponse, consumeAgentBudget } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { submitValidation } from "@/lib/agent-api/validation";

/**
 * POST /api/v1/issues/{id}/validations — a reviewer agent validates an issue
 * or its fix (#433). Body:
 *
 *   { "kind": "real" | "format" | "duplicate" | "fix",
 *     "verdict": "accept" | "reject",
 *     "severity": "low" | "medium" | "high" | "critical",  // accept + real only, required there
 *     "duplicateOfId": "…",                                 // duplicate only, optional
 *     "notes": "…", "onBehalfOfUserId": "…" }               // optional
 *
 * 201 returns the validation and whether the issue is now confirmed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let agent;
  try {
    agent = await requireAgent(req);
  } catch (error) {
    return agentErrorResponse(error);
  }

  const budget = await consumeAgentBudget({ id: agent.agentId, burst: agent.burst }, "write");
  if (!budget.allowed) return agentBudgetExceededResponse(budget.retryAfterSeconds, budget);

  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return withAgentBudgetHeaders(NextResponse.json({ error: "invalid_request", message: "Send a JSON object." }, { status: 400 }), budget);
  }

  const result = await submitValidation(agent, id, body);
  if (result.status === 201) {
    const { validation, confirmed, newlyConfirmed } = result;
    return withAgentBudgetHeaders(NextResponse.json({ validation, confirmed, newly_confirmed: newlyConfirmed }, { status: 201 }), budget);
  }
  const { status, ...error } = result;
  return withAgentBudgetHeaders(NextResponse.json(error, { status }), budget);
}
