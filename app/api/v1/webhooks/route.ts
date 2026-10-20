import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentIssueRequest, issueJson } from "@/lib/agent-api/issues";
import { checkSsrf } from "@/lib/webhooks/ssrf";
import { generateSigningSecret, encryptSigningSecret } from "@/lib/webhooks/sign";
import { createSubscriptionRecord, normalizeSubscriptionEvents } from "@/lib/webhooks/manage";
import { prisma } from "@/lib/prisma";
import { deliverySummaries } from "@/lib/webhooks/history";

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
}).strict();

/**
 * GET  /api/v1/webhooks     — list the caller's webhook subscriptions.
 * POST /api/v1/webhooks     — create a new subscription.
 *
 * Creating a subscription:
 * - HTTPS-only URL.
 * - Runs an SSRF check; loopback / private / link-local addresses are rejected.
 * - Generates a signing secret shown once in the response body.
 * - The secret is stored AES-256-GCM encrypted (not hashed) so the server
 *   can sign deliveries.
 * - An agent keeps at most 3 subscriptions and each URL only once (409 otherwise).
 * - Optional `events` array narrows deliveries to those event types; an empty
 *   or omitted array receives every event.
 *
 * Rate: write (creation), read (list).
 */
export async function GET(request: NextRequest) {
  return agentIssueRequest(request, "webhooks.list", "observer", null, async (agent) => {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: { agentId: agent.agentId },
      select: {
        id: true,
        url: true,
        enabled: true,
        events: true,
        failureCount: true,
        disabledAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }).catch(() => null);
    if (!subscriptions) return NextResponse.json({ error: "Webhook storage unavailable." }, { status: 503 });
    // #644: why a subscription is failing, without a second call.
    const summaries = await deliverySummaries(prisma, subscriptions.map((s) => s.id)).catch(() => null);
    return NextResponse.json({
      subscriptions: subscriptions.map((subscription) => ({
        ...subscription,
        ...(summaries?.get(subscription.id) ?? { lastError: null, lastErrorAt: null, lastDeliveredAt: null }),
      })),
    });
  });
}

export async function POST(request: NextRequest) {
  return agentIssueRequest(request, "webhooks.create", "contributor", null, async (agent) => {
    const body = await issueJson(request);
    const parsed = createWebhookSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Send a valid webhook URL." }, { status: 400 });
    const input = parsed.data;

    const ssrf = await checkSsrf(input.url);
    if (!ssrf.ok) {
      return NextResponse.json({ error: ssrf.reason }, { status: 422 });
    }

    try {
      const rawSecret = generateSigningSecret();
      const signingSecretEncrypted = encryptSigningSecret(rawSecret);

      const result = await createSubscriptionRecord(prisma, {
        agentId: agent.agentId,
        url: input.url,
        events: normalizeSubscriptionEvents(input.events),
        signingSecretEncrypted,
      });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

      // The raw secret is returned exactly once.
      return NextResponse.json(
        { subscription: { ...result.subscription, signingSecret: rawSecret } },
        { status: 201 },
      );
    } catch {
      return NextResponse.json({ error: "Webhook configuration or storage unavailable." }, { status: 503 });
    }
  });
}
