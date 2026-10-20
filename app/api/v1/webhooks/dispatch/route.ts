import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { dispatchDueDeliveries } from "@/lib/webhooks/deliver";
import { pruneAgentRows } from "@/lib/agent-retention";
import { sweepOrphanedAttachments } from "@/lib/attachment-retention";
import { prisma } from "@/lib/prisma";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { agentPlatformDisabledResponse } from "@/lib/agents/platform-gate";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Scheduler only; agent API keys cannot dispatch other agents' subscriptions. */
async function runDispatch() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const processed = await dispatchDueDeliveries();
    // Bounded data retention sweep (1 in N runs does the work, #546, #658); a
    // failing sweep never blocks delivery — the next run picks it up.
    await Promise.resolve().then(() => pruneAgentRows(prisma)).catch(() => null);
    await Promise.resolve().then(() => sweepOrphanedAttachments(prisma)).catch(() => null);
    return NextResponse.json({ processed }, { headers });
  } catch {
    return NextResponse.json(
      { error: "Dispatch unavailable; queued deliveries will retry." },
      { status: 503, headers },
    );
  }
}

function bearerMatches(authorization: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(authorization ?? ""), hash(`Bearer ${secret}`));
}

/**
 * External scheduler (Coolify cron / manual): POST with
 * `Authorization: Bearer $WEBHOOK_DISPATCH_SECRET`.
 */
export async function POST(request: NextRequest) {
  if (!isAgentPlatformEnabled()) return agentPlatformDisabledResponse();
  const secret = process.env.WEBHOOK_DISPATCH_SECRET;
  const headers = { "Cache-Control": "no-store" };
  if (!secret) return NextResponse.json({ error: "Webhook dispatcher is not configured." }, { status: 503, headers });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  return runDispatch();
}

/**
 * Vercel Cron calls the route with GET and `Authorization: Bearer $CRON_SECRET`
 * (#583). Separate secret so a cron-holder cannot impersonate the external
 * scheduler and vice versa.
 */
export async function GET(request: NextRequest) {
  if (!isAgentPlatformEnabled()) return agentPlatformDisabledResponse();
  const secret = process.env.CRON_SECRET;
  const headers = { "Cache-Control": "no-store" };
  if (!secret) return NextResponse.json({ error: "Cron dispatcher is not configured." }, { status: 503, headers });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  return runDispatch();
}
