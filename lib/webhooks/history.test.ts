import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeDeliveryCursor,
  deliveryQuerySchema,
  deliverySummaries,
  encodeDeliveryCursor,
  listDeliveries,
  retryDelivery,
} from "./history";

const db = {
  webhookSubscription: { findFirst: vi.fn() },
  webhookDelivery: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn() },
};

const row = (id: string, status: string, createdAt: string) => ({
  id,
  eventId: `evt-${id}`,
  status,
  attemptCount: 3,
  lastError: status === "dead" ? "HTTP 500 from receiver" : null,
  nextAttemptAt: null,
  deliveredAt: null,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
  event: { type: "comment.created" },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.webhookSubscription.findFirst.mockResolvedValue({ id: "sub-1", enabled: true });
});

describe("listDeliveries (#644)", () => {
  it("is null for a subscription that isn't the agent's, without reading deliveries", async () => {
    db.webhookSubscription.findFirst.mockResolvedValue(null);
    expect(await listDeliveries(db as never, "agent-b", "sub-1", { limit: 20 })).toBeNull();
    expect(db.webhookSubscription.findFirst).toHaveBeenCalledWith({ where: { id: "sub-1", agentId: "agent-b" }, select: { id: true, enabled: true } });
    expect(db.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("returns newest first with the error and event type, and pages", async () => {
    db.webhookDelivery.findMany.mockResolvedValue([
      row("d3", "dead", "2026-10-20T12:03:00Z"),
      row("d2", "delivered", "2026-10-20T12:02:00Z"),
      row("d1", "pending", "2026-10-20T12:01:00Z"),
    ]);
    const page = await listDeliveries(db as never, "agent-a", "sub-1", { limit: 2, status: undefined });
    expect(page?.items.map((d) => d.id)).toEqual(["d3", "d2"]);
    expect(page?.items[0]).toMatchObject({ status: "dead", lastError: "HTTP 500 from receiver", eventType: "comment.created", attemptCount: 3 });
    expect(page?.items[0]).not.toHaveProperty("event");
    expect(decodeDeliveryCursor(page!.nextCursor!)).toEqual({ id: "d2", createdAt: new Date("2026-10-20T12:02:00Z") });
    expect(db.webhookDelivery.findMany.mock.calls[0][0]).toMatchObject({
      where: { subscriptionId: "sub-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("filters by status and continues after a cursor", async () => {
    db.webhookDelivery.findMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-10-20T12:02:00Z"), id: "d2" };
    await listDeliveries(db as never, "agent-a", "sub-1", { limit: 20, status: "dead", cursor });
    expect(db.webhookDelivery.findMany.mock.calls[0][0].where).toEqual({
      subscriptionId: "sub-1",
      status: "dead",
      OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: "d2" } }],
    });
  });

  it("validates the query", () => {
    expect(deliveryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(deliveryQuerySchema.safeParse({ status: "lost" }).success).toBe(false);
    expect(deliveryQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(decodeDeliveryCursor("not-a-cursor")).toBeNull();
    expect(decodeDeliveryCursor(encodeDeliveryCursor({ createdAt: new Date(0), id: "x" }))).toEqual({ createdAt: new Date(0), id: "x" });
  });
});

describe("retryDelivery (#644)", () => {
  it("re-queues a dead delivery with a fresh attempt count", async () => {
    db.webhookDelivery.findFirst.mockResolvedValue({ id: "d3", status: "dead" });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
    db.webhookDelivery.findFirstOrThrow.mockResolvedValue({ ...row("d3", "pending", "2026-10-20T12:03:00Z"), attemptCount: 0 });
    const result = await retryDelivery(db as never, "agent-a", "sub-1", "d3");
    expect(result).toMatchObject({ ok: true, delivery: { id: "d3", status: "pending", attemptCount: 0 } });
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "d3", subscriptionId: "sub-1", status: "dead" },
      data: { status: "pending", nextAttemptAt: null, attemptCount: 0 },
    });
  });

  it("is 404 for another agent's subscription or a delivery on a different subscription", async () => {
    db.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    expect(await retryDelivery(db as never, "agent-b", "sub-1", "d3")).toMatchObject({ ok: false, status: 404 });
    db.webhookDelivery.findFirst.mockResolvedValueOnce(null);
    expect(await retryDelivery(db as never, "agent-a", "sub-1", "elsewhere")).toMatchObject({ ok: false, status: 404 });
    expect(db.webhookDelivery.findFirst).toHaveBeenLastCalledWith({ where: { id: "elsewhere", subscriptionId: "sub-1" }, select: { id: true, status: true } });
    expect(db.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("refuses deliveries that succeeded or are already queued, and disabled subscriptions", async () => {
    db.webhookDelivery.findFirst.mockResolvedValueOnce({ id: "d2", status: "delivered" });
    expect(await retryDelivery(db as never, "agent-a", "sub-1", "d2")).toMatchObject({ status: 409 });
    db.webhookDelivery.findFirst.mockResolvedValueOnce({ id: "d1", status: "pending" });
    expect(await retryDelivery(db as never, "agent-a", "sub-1", "d1")).toMatchObject({ status: 409 });
    db.webhookSubscription.findFirst.mockResolvedValueOnce({ id: "sub-1", enabled: false });
    db.webhookDelivery.findFirst.mockResolvedValueOnce({ id: "d3", status: "dead" });
    expect(await retryDelivery(db as never, "agent-a", "sub-1", "d3")).toMatchObject({ status: 409, error: expect.stringContaining("disabled") });
    expect(db.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("queues once when two retries race", async () => {
    db.webhookDelivery.findFirst.mockResolvedValue({ id: "d3", status: "dead" });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });
    expect(await retryDelivery(db as never, "agent-a", "sub-1", "d3")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("deliverySummaries (#644)", () => {
  it("gives each subscription its newest error and newest success", async () => {
    db.webhookDelivery.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "lastError" in where
        ? { lastError: "HTTP 404", updatedAt: new Date("2026-10-20T12:00:00Z") }
        : { deliveredAt: new Date("2026-10-19T09:00:00Z") },
    );
    const map = await deliverySummaries(db as never, ["sub-1"]);
    expect(map.get("sub-1")).toEqual({
      lastError: "HTTP 404",
      lastErrorAt: new Date("2026-10-20T12:00:00Z"),
      lastDeliveredAt: new Date("2026-10-19T09:00:00Z"),
    });
  });
});
