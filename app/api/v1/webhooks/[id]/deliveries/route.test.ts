import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  webhookSubscription: { findFirst: vi.fn(), findMany: vi.fn() },
  webhookDelivery: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: budget,
}));

import { GET as deliveries } from "./route";
import { POST as retry } from "./[deliveryId]/retry/route";
import { GET as subscriptions } from "../../route";

function request(path: string, method = "GET", keyed = true) {
  return new NextRequest(`http://localhost/api/v1${path}`, {
    method,
    headers: keyed ? { authorization: "Bearer ziki_test-key" } : {},
  });
}
function key(level = "contributor") {
  return {
    id: "key-a",
    revokedAt: null,
    agent: {
      id: "agent-a", name: "Agent", ownerUserId: "owner", tenantId: "tenant-a", level, burst: false, revokedAt: null,
      owner: { memberships: [{ tenantId: "tenant-a" }] },
    },
  };
}
const sub = { params: Promise.resolve({ id: "sub-1" }) };
const one = { params: Promise.resolve({ id: "sub-1", deliveryId: "d3" }) };

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.webhookSubscription.findFirst.mockResolvedValue({ id: "sub-1", enabled: true });
  db.webhookDelivery.findMany.mockResolvedValue([]);
});

describe("GET /api/v1/webhooks/{id}/deliveries (#644)", () => {
  it("needs a key, lets an observer read, and charges a read", async () => {
    expect((await deliveries(request("/webhooks/sub-1/deliveries", "GET", false), sub)).status).toBe(401);
    db.agentApiKey.findUnique.mockResolvedValueOnce(key("observer"));
    const response = await deliveries(request("/webhooks/sub-1/deliveries?status=dead&limit=5"), sub);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(budget).toHaveBeenLastCalledWith({ id: "agent-a", burst: false }, "read");
    expect(db.webhookDelivery.findMany.mock.calls[0][0]).toMatchObject({ where: { subscriptionId: "sub-1", status: "dead" }, take: 6 });
  });

  it("is 404 for another agent's subscription", async () => {
    db.webhookSubscription.findFirst.mockResolvedValue(null);
    expect((await deliveries(request("/webhooks/sub-1/deliveries"), sub)).status).toBe(404);
    expect(db.webhookSubscription.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sub-1", agentId: "agent-a" } }));
  });

  it("rejects a bad status, limit or cursor", async () => {
    expect((await deliveries(request("/webhooks/sub-1/deliveries?status=lost"), sub)).status).toBe(400);
    expect((await deliveries(request("/webhooks/sub-1/deliveries?limit=0"), sub)).status).toBe(400);
    expect((await deliveries(request("/webhooks/sub-1/deliveries?cursor=zzz"), sub)).status).toBe(400);
  });
});

describe("POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry (#644)", () => {
  it("re-queues a dead delivery, charges a write and is audited", async () => {
    db.webhookDelivery.findFirst.mockResolvedValue({ id: "d3", status: "dead" });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
    db.webhookDelivery.findFirstOrThrow.mockResolvedValue({
      id: "d3", eventId: "e", status: "pending", attemptCount: 0, lastError: "HTTP 500", nextAttemptAt: null,
      deliveredAt: null, createdAt: new Date(), updatedAt: new Date(), event: { type: "issue.created" },
    });
    const response = await retry(request("/webhooks/sub-1/deliveries/d3/retry", "POST"), one);
    expect(response.status).toBe(200);
    expect((await response.json()).delivery).toMatchObject({ id: "d3", status: "pending", eventType: "issue.created" });
    expect(budget).toHaveBeenLastCalledWith({ id: "agent-a", burst: false }, "write");
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "webhooks.retryDelivery", target: "d3" }),
    });
  });

  it("needs contributor, and is 404 for another agent's subscription", async () => {
    db.agentApiKey.findUnique.mockResolvedValueOnce(key("observer"));
    expect((await retry(request("/webhooks/sub-1/deliveries/d3/retry", "POST"), one)).status).toBe(403);
    db.webhookSubscription.findFirst.mockResolvedValue(null);
    expect((await retry(request("/webhooks/sub-1/deliveries/d3/retry", "POST"), one)).status).toBe(404);
    expect(db.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("is 429 without touching the delivery when the write budget is spent", async () => {
    budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await retry(request("/webhooks/sub-1/deliveries/d3/retry", "POST"), one)).status).toBe(429);
    expect(db.webhookDelivery.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/webhooks shows why a subscription is failing (#644)", () => {
  it("adds lastError, lastErrorAt and lastDeliveredAt", async () => {
    db.webhookSubscription.findMany.mockResolvedValue([{ id: "sub-1", url: "https://r.test", enabled: false, events: [], failureCount: 5, disabledAt: new Date(), createdAt: new Date(), updatedAt: new Date() }]);
    db.webhookDelivery.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "lastError" in where ? { lastError: "HTTP 410 Gone", updatedAt: new Date("2026-10-20T10:00:00Z") } : null,
    );
    const body = await (await subscriptions(request("/webhooks"))).json();
    expect(body.subscriptions[0]).toMatchObject({ id: "sub-1", lastError: "HTTP 410 Gone", lastErrorAt: "2026-10-20T10:00:00.000Z", lastDeliveredAt: null });
  });
});
