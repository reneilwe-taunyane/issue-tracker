import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_RETENTION_MS,
  DELIVERY_RETENTION_MS,
  EVENT_RETENTION_MS,
  PAIRING_RETENTION_MS,
  RETENTION_BATCH,
  RETENTION_SWEEP_EVERY,
  pruneAgentRows,
} from "./agent-retention";
import { RATE_LIMIT_RETENTION_MS } from "@/lib/rate-limit";

const now = new Date("2026-10-20T12:00:00Z");
const cutoff = (ms: number) => new Date(now.getTime() - ms);

type Model = {
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

function model(removed = 0, id: (index: number) => string | bigint = (i) => `row-${i}`): Model {
  return {
    findMany: vi.fn(async () => Array.from({ length: removed }, (_, i) => ({ id: id(i) }))),
    deleteMany: vi.fn(async () => ({ count: removed })),
  };
}

function makeDb() {
  return {
    webhookDelivery: model(),
    agentEvent: model(),
    agentPairing: model(),
    agentAuditEvent: model(),
    rateLimitHit: model(),
  };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  vi.resetAllMocks();
  db = makeDb();
});

describe("agent data retention (#546)", () => {
  it("documents every policy: expired pairings 1 day, events 7 days, delivered/dead deliveries 30 days, audit 180 days", () => {
    expect(PAIRING_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(EVENT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DELIVERY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(AUDIT_RETENTION_MS).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it("always prunes rate-limit hits when the regular sweep is off", async () => {
    await expect(pruneAgentRows(db as never, { now, sweep: false })).resolves.toEqual({
      deliveries: 0, events: 0, pairings: 0, auditEvents: 0, rateLimitHits: 0,
    });
    expect(db.rateLimitHit.findMany).toHaveBeenCalledWith({
      where: { at: { lt: BigInt(now.getTime() - RATE_LIMIT_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
    expect(db.rateLimitHit.deleteMany).not.toHaveBeenCalled();
    for (const table of Object.entries(db).filter(([name]) => name !== "rateLimitHit").map(([, table]) => table)) {
      expect(table.findMany).not.toHaveBeenCalled();
      expect(table.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("applies each table's retention filter in bounded batches", async () => {
    await pruneAgentRows(db as never, { now, sweep: true });
    expect(db.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: { status: { in: ["delivered", "dead"] }, createdAt: { lt: cutoff(DELIVERY_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
    expect(db.agentEvent.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff(EVENT_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
    expect(db.agentPairing.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: cutoff(PAIRING_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
    expect(db.agentAuditEvent.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff(AUDIT_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
    expect(db.rateLimitHit.findMany).toHaveBeenCalledWith({
      where: { at: { lt: BigInt(now.getTime() - RATE_LIMIT_RETENTION_MS) } },
      select: { id: true },
      take: RETENTION_BATCH,
    });
  });

  it("deletes the found rows with the retention filter re-checked and sums the counts", async () => {
    db.webhookDelivery = model(2);
    db.agentEvent = model(5);
    db.agentPairing = model(1);
    db.agentAuditEvent = model(3);
    db.rateLimitHit = model(2, (i) => BigInt(i + 1));
    await expect(pruneAgentRows(db as never, { now, sweep: true })).resolves.toEqual({
      deliveries: 2, events: 5, pairings: 1, auditEvents: 3, rateLimitHits: 2,
    });
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["row-0", "row-1"] },
        status: { in: ["delivered", "dead"] },
        createdAt: { lt: cutoff(DELIVERY_RETENTION_MS) },
      },
    });
    expect(db.agentEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["row-0", "row-1", "row-2", "row-3", "row-4"] }, createdAt: { lt: cutoff(EVENT_RETENTION_MS) } },
    });
    expect(db.agentPairing.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["row-0"] }, expiresAt: { lt: cutoff(PAIRING_RETENTION_MS) } },
    });
    expect(db.agentAuditEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["row-0", "row-1", "row-2"] }, createdAt: { lt: cutoff(AUDIT_RETENTION_MS) } },
    });
    expect(db.rateLimitHit.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: [BigInt(1), BigInt(2)] },
        at: { lt: BigInt(now.getTime() - RATE_LIMIT_RETENTION_MS) },
      },
    });
  });

  it("keeps only finished webhook deliveries: pending and failed rows are never pruned", async () => {
    await pruneAgentRows(db as never, { now, sweep: true });
    const where = db.webhookDelivery.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(["delivered", "dead"]);
    expect(where.status.in).not.toContain("pending");
    expect(where.status.in).not.toContain("failed");
  });

  it("counts zero when a sweep batch races an update and nothing qualifies anymore", async () => {
    db.agentEvent = model(4);
    db.agentEvent.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(pruneAgentRows(db as never, { now, sweep: true })).resolves.toEqual({
      deliveries: 0, events: 0, pairings: 0, auditEvents: 0, rateLimitHits: 0,
    });
  });

  it("sweeps every Nth call on average and the batch knob stays bounded", () => {
    expect(RETENTION_SWEEP_EVERY).toBeGreaterThan(1);
    expect(RETENTION_BATCH).toBeGreaterThan(0);
    expect(RETENTION_BATCH).toBeLessThanOrEqual(500);
  });
});
