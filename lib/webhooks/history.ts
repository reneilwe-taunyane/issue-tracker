import type { Prisma, PrismaClient, WebhookDeliveryStatus } from "@prisma/client";
import { z } from "zod";

/**
 * Delivery history for an agent's own webhook subscriptions (#644).
 *
 * Every call is scoped by subscription id AND the calling agent, so another
 * agent's subscription or delivery is indistinguishable from one that doesn't
 * exist (404). Bodies and signatures are never returned, only the outcome.
 */

type Db = Pick<PrismaClient, "webhookSubscription" | "webhookDelivery">;

export const DELIVERY_PAGE_DEFAULT = 20;
export const DELIVERY_PAGE_MAX = 100;
const STATUSES = ["pending", "delivered", "failed", "dead"] as const;

export const deliveryQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(DELIVERY_PAGE_MAX).default(DELIVERY_PAGE_DEFAULT),
  cursor: z.string().max(200).optional(),
});

export type DeliveryCursor = { createdAt: Date; id: string };

export function encodeDeliveryCursor(cursor: DeliveryCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeDeliveryCursor(raw: string): DeliveryCursor | null {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const deliverySelect = {
  id: true,
  eventId: true,
  status: true,
  attemptCount: true,
  lastError: true,
  nextAttemptAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  event: { select: { type: true } },
} satisfies Prisma.WebhookDeliverySelect;

type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{ select: typeof deliverySelect }>;

function present(row: DeliveryRow) {
  const { event, ...rest } = row;
  return { ...rest, eventType: event.type };
}

/** Is this subscription the agent's own? */
async function ownSubscription(db: Db, agentId: string, subscriptionId: string) {
  return db.webhookSubscription.findFirst({
    where: { id: subscriptionId, agentId },
    select: { id: true, enabled: true },
  });
}

/** Newest first, optionally one status, paged by (createdAt, id). Null when not the agent's. */
export async function listDeliveries(
  db: Db,
  agentId: string,
  subscriptionId: string,
  query: { status?: WebhookDeliveryStatus; limit: number; cursor?: DeliveryCursor | null },
) {
  if (!(await ownSubscription(db, agentId, subscriptionId))) return null;
  const rows = await db.webhookDelivery.findMany({
    where: {
      subscriptionId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor
        ? {
            OR: [
              { createdAt: { lt: query.cursor.createdAt } },
              { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: deliverySelect,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(present),
    nextCursor: rows.length > query.limit && last ? encodeDeliveryCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/**
 * The newest error and the newest successful delivery for each subscription,
 * for the list payload. Two small queries per subscription; an agent has at
 * most three.
 */
export async function deliverySummaries(db: Db, subscriptionIds: string[]) {
  const entries = await Promise.all(
    subscriptionIds.map(async (subscriptionId) => {
      const [lastFailure, lastSuccess] = await Promise.all([
        db.webhookDelivery.findFirst({
          where: { subscriptionId, lastError: { not: null } },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: { lastError: true, updatedAt: true },
        }),
        db.webhookDelivery.findFirst({
          where: { subscriptionId, deliveredAt: { not: null } },
          orderBy: [{ deliveredAt: "desc" }, { id: "desc" }],
          select: { deliveredAt: true },
        }),
      ]);
      return [
        subscriptionId,
        {
          lastError: lastFailure?.lastError ?? null,
          lastErrorAt: lastFailure?.updatedAt ?? null,
          lastDeliveredAt: lastSuccess?.deliveredAt ?? null,
        },
      ] as const;
    }),
  );
  return new Map(entries);
}

export type RetryResult =
  | { ok: true; delivery: ReturnType<typeof present> }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Re-queue one failed or dead delivery for the next dispatch (#644). The
 * attempt count starts over, so it gets the normal backoff and retries. The
 * subscription must be enabled: re-enable (or rotate) it first.
 */
export async function retryDelivery(
  db: Db,
  agentId: string,
  subscriptionId: string,
  deliveryId: string,
): Promise<RetryResult> {
  const subscription = await ownSubscription(db, agentId, subscriptionId);
  if (!subscription) return { ok: false, status: 404, error: "Webhook subscription not found." };
  const delivery = await db.webhookDelivery.findFirst({
    where: { id: deliveryId, subscriptionId },
    select: { id: true, status: true },
  });
  if (!delivery) return { ok: false, status: 404, error: "Delivery not found." };
  if (!subscription.enabled) {
    return { ok: false, status: 409, error: "This subscription is disabled. Re-enable it with PATCH /api/v1/webhooks/{id} first." };
  }
  if (delivery.status === "delivered") return { ok: false, status: 409, error: "This delivery already succeeded." };
  if (delivery.status === "pending") return { ok: false, status: 409, error: "This delivery is already queued." };
  // Conditional on the status read above, so two retries at once queue it once.
  const requeued = await db.webhookDelivery.updateMany({
    where: { id: delivery.id, subscriptionId, status: delivery.status },
    data: { status: "pending", nextAttemptAt: null, attemptCount: 0 },
  });
  if (requeued.count !== 1) return { ok: false, status: 409, error: "This delivery is already queued." };
  const row = await db.webhookDelivery.findFirstOrThrow({ where: { id: delivery.id }, select: deliverySelect });
  return { ok: true, delivery: present(row) };
}
