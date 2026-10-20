import type { PrismaClient } from "@prisma/client";
import { RATE_LIMIT_RETENTION_MS } from "@/lib/rate-limit";

/**
 * #546: retention for the agent tables that previously grew forever. Only
 * `RateLimitHit`, idempotency keys, invites and unlinked uploads were pruned
 * before; every agent read also writes an audit row, so audit grew fastest.
 *
 * | Table           | Policy                                            |
 * | --------------- | ------------------------------------------------- |
 * | AgentPairing    | removed 1 day after its `expiresAt`               |
 * | AgentEvent      | removed after 7 days; its webhook deliveries go   |
 * |                 | with it (FK cascade), which also bounds them      |
 * | WebhookDelivery | finished attempts (delivered/dead) after 30 days  |
 * | AgentAuditEvent | rows older than 180 days                          |
 *
 * The audit window keeps any plausible undo target: undos (#450) act on
 * recent actions, and every row younger than 180 days is always kept.
 *
 * `pruneAgentRows` is called from the dispatch scheduler
 * (`POST /api/v1/webhooks/dispatch`). A random 1-in-`RETENTION_SWEEP_EVERY`
 * gate keeps the sweep cheap per tick while running it about every Nth
 * scheduler call (the scheduler is configured for every 10 seconds). Each
 * table loses at most `RETENTION_BATCH` rows per sweep, so one request never
 * does unbounded work — a big backlog drains over several sweeps. The caller
 * swallows failures; the next sweep picks the rows up again.
 */
export const PAIRING_RETENTION_MS = 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Rows removed per table per sweep, so one request never does unbounded work. */
export const RETENTION_BATCH = 500;

/** How often (1 in N dispatch runs) the retention sweep actually runs. */
export const RETENTION_SWEEP_EVERY = 50;

type RetentionDb = Pick<
  PrismaClient,
  "agentPairing" | "agentEvent" | "webhookDelivery" | "agentAuditEvent" | "rateLimitHit"
>;
type Prunable = {
  findMany: (args: { where: object; select: { id: true }; take: number }) => Promise<Array<{ id: string | bigint }>>;
  deleteMany: (args: { where: object }) => Promise<{ count: number }>;
};

export type AgentRetentionCounts = {
  pairings: number;
  deliveries: number;
  events: number;
  auditEvents: number;
  rateLimitHits: number;
};

/**
 * Find one batch of old rows and delete exactly those rows, re-checking the
 * original filter in the delete itself (as attachment-retention does) so a
 * row that changed while sweeping is not removed on stale information.
 */
async function pruneBatch(model: Prunable, where: object): Promise<number> {
  const stale = await model.findMany({ where, select: { id: true }, take: RETENTION_BATCH });
  if (stale.length === 0) return 0;
  const removed = await model.deleteMany({
    where: { id: { in: stale.map((row) => row.id) }, ...where },
  });
  return removed.count;
}

export async function pruneAgentRows(
  db: RetentionDb,
  {
    now = new Date(),
    sweep = Math.random() * RETENTION_SWEEP_EVERY < 1,
  }: { now?: Date; sweep?: boolean } = {},
): Promise<AgentRetentionCounts> {
  const counts = { pairings: 0, deliveries: 0, events: 0, auditEvents: 0, rateLimitHits: 0 };
  counts.rateLimitHits = await pruneBatch(
    db.rateLimitHit as unknown as Prunable,
    { at: { lt: BigInt(now.getTime() - RATE_LIMIT_RETENTION_MS) } },
  );
  if (!sweep) return counts;
  counts.deliveries = await pruneBatch(
    db.webhookDelivery as unknown as Prunable,
    { status: { in: ["delivered", "dead"] }, createdAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } },
  );
  counts.events = await pruneBatch(
    db.agentEvent as unknown as Prunable,
    { createdAt: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) } },
  );
  counts.pairings = await pruneBatch(
    db.agentPairing as unknown as Prunable,
    { expiresAt: { lt: new Date(now.getTime() - PAIRING_RETENTION_MS) } },
  );
  counts.auditEvents = await pruneBatch(
    db.agentAuditEvent as unknown as Prunable,
    { createdAt: { lt: new Date(now.getTime() - AUDIT_RETENTION_MS) } },
  );
  return counts;
}
