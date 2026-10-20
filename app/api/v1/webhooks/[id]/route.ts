import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { generateSigningSecret, encryptSigningSecret } from "@/lib/webhooks/sign";
import { prisma } from "@/lib/prisma";

/**
 * DELETE /api/v1/webhooks/[id]  — delete a webhook subscription.
 * PATCH  /api/v1/webhooks/[id]  — re-enable a disabled subscription, or rotate
 *                                  its signing secret.
 */

const updateSchema = z.object({ rotateSecret: z.boolean().optional() }).strict();

/**
 * What the request asks for. The body is read before the request is
 * authenticated because it decides which action is audited, but reading it
 * changes nothing: a malformed body is reported only after the key is
 * accepted, so an anonymous caller still learns nothing about the route.
 */
async function readUpdate(
  request: NextRequest,
): Promise<{ rotateSecret?: boolean; error?: string }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: "Send a valid JSON body." };
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Send a valid JSON body." };
  }
  const result = updateSchema.safeParse(parsed);
  if (!result.success) return { error: "Send a valid JSON body." };
  return { rotateSecret: result.data.rotateSecret };
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return agentIssueRequest(request, "webhooks.delete", "contributor", id, async (agent) => {
    try {
      const existing = await prisma.webhookSubscription.findFirst({
        where: { id, agentId: agent.agentId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Webhook subscription not found." }, { status: 404 });
      }
      await prisma.webhookSubscription.delete({ where: { id } });
      return new NextResponse(null, { status: 204 });
    } catch { return NextResponse.json({ error: "Webhook storage unavailable." }, { status: 503 }); }
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const update = await readUpdate(request);
  const rotate = update.rotateSecret === true;
  return agentIssueRequest(
    request,
    rotate ? "webhooks.rotateSecret" : "webhooks.enable",
    "contributor",
    id,
    async (agent) => {
      if (update.error) return NextResponse.json({ error: update.error }, { status: 400 });
      try {
        const existing = await prisma.webhookSubscription.findFirst({
          where: { id, agentId: agent.agentId },
          select: { id: true },
        });
        if (!existing) {
          return NextResponse.json({ error: "Webhook subscription not found." }, { status: 404 });
        }

        // Rotating replaces the secret the receiver verifies deliveries with.
        // The new raw secret is shown once, like on creation; the stored copy
        // stays encrypted so the server can keep signing. Deliveries are signed
        // when they are sent, so pending ones go out with the new secret.
        //
        // #643: rotation is also how a receiver recovers after a leak, and a
        // subscription that failed while its secret was wrong would otherwise
        // stay disabled. Rotating clears the failure count and re-enables it,
        // keeping the same id and delivery history.
        if (rotate) {
          const rawSecret = generateSigningSecret();
          const signingSecretEncrypted = encryptSigningSecret(rawSecret);
          const subscription = await prisma.webhookSubscription.update({
            where: { id },
            data: { signingSecretEncrypted, enabled: true, disabledAt: null, failureCount: 0 },
            select: { id: true, url: true, enabled: true, failureCount: true, createdAt: true, updatedAt: true },
          });
          return NextResponse.json({ subscription: { ...subscription, signingSecret: rawSecret } });
        }

        const subscription = await prisma.webhookSubscription.update({
          where: { id },
          data: { enabled: true, disabledAt: null, failureCount: 0 },
          select: { id: true, url: true, enabled: true, failureCount: true, createdAt: true, updatedAt: true },
        });
        return NextResponse.json({ subscription });
      } catch { return NextResponse.json({ error: "Webhook storage unavailable." }, { status: 503 }); }
    },
  );
}
