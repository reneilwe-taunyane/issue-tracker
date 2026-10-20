import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { prisma } from "@/lib/prisma";
import { retryDelivery } from "@/lib/webhooks/history";

/**
 * POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry — re-queue one
 * failed or dead delivery so the next dispatch sends it again (#644).
 * Contributor+, charged to the write budget and audited. 409 when the
 * delivery already succeeded or is queued, or the subscription is disabled.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; deliveryId: string }> },
) {
  const { id, deliveryId } = await params;
  return agentIssueRequest(request, "webhooks.retryDelivery", "contributor", deliveryId, async (agent) => {
    try {
      const result = await retryDelivery(prisma, agent.agentId, id, deliveryId);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ delivery: result.delivery });
    } catch {
      return NextResponse.json({ error: "Webhook storage unavailable." }, { status: 503 });
    }
  });
}
