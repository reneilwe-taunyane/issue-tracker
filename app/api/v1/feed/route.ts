import { NextResponse, type NextRequest } from "next/server";
import { agentErrorResponse, assertKeyProject, requireAgent, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { consumeAgentBudget, agentBudgetExceededResponse } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders, type AgentBudgetQuota } from "@/lib/agents/rate-budget-headers";
import { resolveSessionUserId } from "@/lib/session-user";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { FeedInputError, feedProject, parseFeedCursor, readFeed } from "@/lib/feed";

export async function GET(request: NextRequest) {
  try {
    let tenantId: string | null;
    let agent: AgentContext | undefined;
    let quota: AgentBudgetQuota = {};
    // A supplied bad key must not fall back to a valid browser session.
    if (request.headers.has("authorization")) {
      agent = await requireAgent(request);
      requireLevel(agent, "observer");
      const budget = await consumeAgentBudget({ id: agent.agentId, burst: agent.burst }, "read");
      await audit(agent, "feed.read", request.nextUrl.searchParams.get("projectId"));
      if (!budget.allowed) return agentBudgetExceededResponse(budget.retryAfterSeconds, budget);
      quota = budget;
      tenantId = agent.tenantId;
    } else {
      const session = await resolveSessionUserId();
      if ("error" in session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      tenantId = await currentTenantIdFor(session.userId);
    }
    if (!tenantId) return NextResponse.json({ error: "No workspace membership." }, { status: 403 });
    const cursor = parseFeedCursor(request.nextUrl.searchParams);
    const project = await feedProject(tenantId, request.nextUrl.searchParams.get("projectId"));
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    if (agent) assertKeyProject(agent, project.id);
    return withAgentBudgetHeaders(
      NextResponse.json(await readFeed(tenantId, project.id, cursor), {
        headers: { "Cache-Control": "private, no-store" },
      }),
      quota,
    );
  } catch (error) {
    if (error instanceof FeedInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return agentErrorResponse(error);
  }
}
