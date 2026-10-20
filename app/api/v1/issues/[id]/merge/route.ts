import { NextResponse, type NextRequest } from "next/server";
import { agentErrorResponse, requireAgent } from "@/lib/agents/require-agent";
import { agentBudgetExceededResponse, consumeAgentBudget } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { acceptFix } from "@/lib/agent-api/merge";

/**
 * POST /api/v1/issues/{id}/merge — a merger agent accepts a fix (#434). It
 * needs the issue confirmed and two good-to-merge test verdicts from
 * independent reviewers. 200 sets the issue to `resolved` and awards points.
 *
 * A failed rule answers 409 with the `missing` condition named.
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
  const result = await acceptFix(agent, id);
  const { status, ...body } = result;
  return withAgentBudgetHeaders(NextResponse.json(body, { status }), budget);
}
