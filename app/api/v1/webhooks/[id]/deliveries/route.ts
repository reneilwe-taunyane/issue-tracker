import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { prisma } from "@/lib/prisma";
import { decodeDeliveryCursor, deliveryQuerySchema, listDeliveries } from "@/lib/webhooks/history";

/**
 * GET /api/v1/webhooks/{id}/deliveries?status=&limit=&cursor= — recent
 * deliveries for one of the calling agent's subscriptions, newest first
 * (#644): status, attempts, last error and timestamps. Observer+, read budget.
 * Another agent's subscription answers 404.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return agentIssueRequest(request, "webhooks.deliveries", "observer", id, async (agent) => {
    const parsed = deliveryQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "status must be pending, delivered, failed or dead; limit 1–100." },
        { status: 400 },
      );
    }
    const cursor = parsed.data.cursor ? decodeDeliveryCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    try {
      const page = await listDeliveries(prisma, agent.agentId, id, { ...parsed.data, cursor });
      if (!page) return NextResponse.json({ error: "Webhook subscription not found." }, { status: 404 });
      return NextResponse.json(page);
    } catch {
      return NextResponse.json({ error: "Webhook storage unavailable." }, { status: 503 });
    }
  });
}
