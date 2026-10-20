import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() }, agentAuditEvent: { create: vi.fn() }, agentEvent: { findMany: vi.fn() }, $queryRaw: vi.fn(),
  webhookSubscription: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
const ssrf = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({ ...await original<typeof import("@/lib/agents/rate-budget")>(), consumeAgentBudget: budget }));
vi.mock("@/lib/webhooks/ssrf", () => ({ checkSsrf: ssrf }));
import { GET } from "./route";
import { GET as subscriptions, POST as subscribe } from "../webhooks/route";
import { DELETE, PATCH } from "../webhooks/[id]/route";
import { decodeEventCursor, encodeEventCursor } from "@/lib/agent-api/events";
import { decryptSigningSecret, sign, verify } from "@/lib/webhooks/sign";

function request(path = "/events", method = "GET", body?: unknown, key = true) {
  return new NextRequest(`http://localhost/api/v1${path}`, { method,
    headers: { ...(key ? { authorization: "Bearer ziki_test-key" } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const context = { params: Promise.resolve({ id: "subscription-a" }) };
const event = { id: "event-a", txid: BigInt("100"), createdAt: new Date("2026-10-19T12:00:00Z"), type: "issue.created", payload: {}, actorAgentId: "agent-a", bugId: "issue-a" };
function key(level = "contributor") {
  return { id: "key-a", revokedAt: null, agent: { id: "agent-a", name: "Agent", ownerUserId: "owner", tenantId: "tenant-a", level, burst: false, revokedAt: null, owner: { memberships: [{ tenantId: "tenant-a" }] } } };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WEBHOOK_SECRET_KEY", "a".repeat(64));
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.agentEvent.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([{ xmin: "1000" }]);
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.webhookSubscription.count.mockResolvedValue(0);
  db.webhookSubscription.findFirst.mockResolvedValue({ id: "subscription-a" });
  db.webhookSubscription.create.mockResolvedValue({ id: "subscription-a", url: "https://receiver.test/hook" });
  db.webhookSubscription.update.mockResolvedValue({ id: "subscription-a", enabled: true });
  ssrf.mockResolvedValue({ ok: true, address: "93.184.216.34" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("events endpoint", () => {
  it("rejects anonymous and invalid keys", async () => {
    expect((await GET(request("/events", "GET", undefined, false))).status).toBe(401);
    db.agentApiKey.findUnique.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect(db.agentEvent.findMany).not.toHaveBeenCalled();
  });
  it("allows an observer, scopes by tenant, charges a read and audits", async () => {
    db.agentApiKey.findUnique.mockResolvedValueOnce(key("observer"));
    db.agentEvent.findMany.mockResolvedValue([event]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(db.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-a", txid: { lt: BigInt("1000") } } }));
    expect(budget).toHaveBeenCalledWith({ id: "agent-a", burst: false }, "read");
    expect(db.agentAuditEvent.create).toHaveBeenCalled();
    expect(decodeEventCursor((await response.json()).cursor)?.id).toBe(event.id);
  });
  it("paginates ties without advancing beyond returned events and preserves an empty cursor", async () => {
    db.agentEvent.findMany.mockResolvedValueOnce(Array.from({ length: 101 }, (_, i) => ({ ...event, id: `event-${i}` })));
    const page = await (await GET(request())).json();
    expect(page.events).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(decodeEventCursor(page.cursor)?.id).toBe("event-99");
    const empty = await (await GET(request(`/events?after=${page.cursor}`))).json();
    expect(empty.cursor).toBe(page.cursor);
    expect(db.agentEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: {
      tenantId: "tenant-a", txid: { lt: BigInt("1000") }, OR: [{ txid: { gt: event.txid } }, { txid: event.txid, id: { gt: "event-99" } }],
    } }));
  });
  it("long-polls until an event arrives and returns immediately for wait=0", async () => {
    vi.useFakeTimers();
    db.agentEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
    let settled = false;
    const pending = GET(request("/events?wait=25")).then((response) => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await (await pending).json()).events[0].id).toBe(event.id);
    const start = Date.now();
    expect((await GET(request("/events?wait=0"))).status).toBe(200);
    expect(Date.now()).toBe(start);
  });
  it("validates wait/cursor input and returns 429/503 failures", async () => {
    for (const query of ["wait=-1", "wait=26", "wait=Infinity", "wait=bad", "wait=", "afterId=only", "after=bad", "after=&afterId=x"]) {
      expect((await GET(request(`/events?${query}`))).status).toBe(400);
    }
    budget.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 15 });
    const limited = await GET(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("15");
    db.agentEvent.findMany.mockRejectedValueOnce(new Error("DB"));
    expect((await GET(request())).status).toBe(503);
    expect(encodeEventCursor({ createdAt: event.createdAt, id: event.id })).toBeTruthy();
  });

  it("filters by type, project and issue, combined with the global cursor (#602)", async () => {
    const cursor = encodeEventCursor({ txid: event.txid, id: event.id });
    db.agentEvent.findMany.mockResolvedValue([{ ...event, id: "event-b" }]);
    const response = await GET(request(`/events?types=comment.created,claim.*&projectId=proj-1&bugId=issue-a&after=${cursor}`));
    expect(response.status).toBe(200);
    expect(db.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      tenantId: "tenant-a", projectId: "proj-1", bugId: "issue-a",
      AND: [{ OR: [{ type: { in: ["comment.created"] } }, { type: { startsWith: "claim." } }] }],
      txid: { lt: BigInt("1000") }, OR: [{ txid: { gt: event.txid } }, { txid: event.txid, id: { gt: event.id } }],
    } }));
    expect(decodeEventCursor((await response.json()).cursor)?.id).toBe("event-b");
    await GET(request("/events?projectId=proj-1"));
    expect(db.agentEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenantId: "tenant-a", projectId: "proj-1", txid: { lt: BigInt("1000") } } }));
  });

  it("returns 400 listing the valid types for an unknown type (#602)", async () => {
    const response = await GET(request("/events?types=comment.created,issue.nope"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("issue.nope");
    expect(body.validTypes).toContain("comment.created");
    for (const query of ["types=", "types=nope.*", "projectId=", "bugId="]) {
      expect((await GET(request(`/events?${query}`))).status, query).toBe(400);
    }
    expect(db.agentEvent.findMany).not.toHaveBeenCalled();
  });

  it("ends a long poll at its deadline without losing the existing cursor", async () => {
    vi.useFakeTimers();
    const cursor = encodeEventCursor({ createdAt: event.createdAt, id: event.id });
    const pending = GET(request(`/events?wait=1&after=${cursor}`));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await (await pending).json()).toEqual({ events: [], cursor, hasMore: false });
  });
});

describe("webhook subscription endpoints", () => {
  it("requires keys and contributor writes", async () => {
    expect((await subscribe(request("/webhooks", "POST", {}, false))).status).toBe(401);
    db.agentApiKey.findUnique.mockResolvedValue(key("observer"));
    expect((await subscriptions(request("/webhooks"))).status).toBe(200);
    expect((await subscribe(request("/webhooks", "POST", { url: "https://receiver.test" }))).status).toBe(403);
    expect((await DELETE(request("/webhooks/id", "DELETE"), context)).status).toBe(403);
    expect((await PATCH(request("/webhooks/id", "PATCH"), context)).status).toBe(403);
  });
  it("encrypts a one-time secret and excludes it from list queries", async () => {
    db.webhookSubscription.findFirst.mockResolvedValue(null);
    const response = await subscribe(request("/webhooks", "POST", { url: "https://receiver.test/hook" }));
    expect(response.status).toBe(201);
    expect(db.webhookSubscription.create.mock.calls[0][0].data.events).toEqual([]);
    const secret = (await response.json()).subscription.signingSecret;
    const stored = db.webhookSubscription.create.mock.calls[0][0].data.signingSecretEncrypted;
    expect(stored).not.toBe(secret);
    expect(decryptSigningSecret(stored)).toBe(secret);
    await subscriptions(request("/webhooks"));
    expect(db.webhookSubscription.findMany.mock.calls[0][0].select).not.toHaveProperty("signingSecretEncrypted");
    expect(db.webhookSubscription.findMany.mock.calls[0][0].where).toEqual({ agentId: "agent-a" });
  });
  it("rejects invalid payloads and private addresses before storing", async () => {
    expect((await subscribe(request("/webhooks", "POST", {}))).status).toBe(400);
    ssrf.mockResolvedValueOnce({ ok: false, reason: "Private address" });
    expect((await subscribe(request("/webhooks", "POST", { url: "https://127.0.0.1" }))).status).toBe(422);
    expect(db.webhookSubscription.create).not.toHaveBeenCalled();
  });
  it("enforces the subscription cap and per-agent URL uniqueness (#512)", async () => {
    db.webhookSubscription.count.mockResolvedValueOnce(3);
    db.webhookSubscription.findFirst.mockResolvedValue(null);
    const capped = await subscribe(request("/webhooks", "POST", { url: "https://receiver.test/hook" }));
    expect(capped.status).toBe(409);
    expect((await capped.json()).error).toContain("at most 3");
    expect(db.webhookSubscription.create).not.toHaveBeenCalled();
    db.webhookSubscription.findFirst.mockResolvedValueOnce({ id: "subscription-a" });
    const duplicate = await subscribe(request("/webhooks", "POST", { url: "https://receiver.test/hook" }));
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toContain("already subscribed");
    expect(db.webhookSubscription.create).not.toHaveBeenCalled();
  });
  it("scopes deletion/re-enabling and handles unavailable storage", async () => {
    db.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    expect((await DELETE(request("/webhooks/id", "DELETE"), context)).status).toBe(404);
    expect(db.webhookSubscription.delete).not.toHaveBeenCalled();
    expect((await PATCH(request("/webhooks/id", "PATCH"), context)).status).toBe(200);
    expect(db.webhookSubscription.findFirst).toHaveBeenLastCalledWith({ where: { id: "subscription-a", agentId: "agent-a" }, select: { id: true } });
    expect((await DELETE(request("/webhooks/id", "DELETE"), context)).status).toBe(204);
    db.webhookSubscription.findMany.mockRejectedValueOnce(new Error("DB"));
    expect((await subscriptions(request("/webhooks"))).status).toBe(503);
    vi.stubEnv("WEBHOOK_SECRET_KEY", "invalid");
    expect((await subscribe(request("/webhooks", "POST", { url: "https://receiver.test" }))).status).toBe(503);
  });

  it("rotates the signing secret and shows the raw secret once (#682)", async () => {
    const response = await PATCH(
      request("/webhooks/id", "PATCH", { rotateSecret: true }),
      context,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const rawSecret = body.subscription.signingSecret;
    expect(rawSecret).toBeTruthy();
    // The stored copy is encrypted, so the server can keep signing deliveries.
    const stored = db.webhookSubscription.update.mock.calls[0][0].data.signingSecretEncrypted;
    expect(stored).not.toBe(rawSecret);
    expect(decryptSigningSecret(stored)).toBe(rawSecret);
    // #643: rotating also clears the failures and re-enables the subscription,
    // keeping the same id.
    expect(db.webhookSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { id: "subscription-a" },
      data: { signingSecretEncrypted: stored, enabled: true, disabledAt: null, failureCount: 0 },
    });
  });

  it("makes the old secret stop verifying and keeps the raw secret out of the audit log (#643)", async () => {
    const first = await (await PATCH(request("/webhooks/id", "PATCH", { rotateSecret: true }), context)).json();
    const second = await (await PATCH(request("/webhooks/id", "PATCH", { rotateSecret: true }), context)).json();
    const oldSecret = first.subscription.signingSecret as string;
    const newSecret = second.subscription.signingSecret as string;
    expect(newSecret).not.toBe(oldSecret);

    // A delivery signed now uses the stored (new) secret.
    const stored = db.webhookSubscription.update.mock.calls[1][0].data.signingSecretEncrypted;
    const timestampMs = Date.now();
    const rawBody = JSON.stringify({ type: "issue.created" });
    const signature = sign({ rawSecret: decryptSigningSecret(stored), timestampMs, rawBody });
    expect(verify({ rawSecret: newSecret, signature, timestampMs, rawBody })).toBe(true);
    expect(verify({ rawSecret: oldSecret, signature, timestampMs, rawBody })).toBe(false);

    // The audit rows record the action and status, never the secret.
    const audited = JSON.stringify(db.agentAuditEvent.create.mock.calls);
    expect(audited).toContain("webhooks.rotateSecret");
    expect(audited).not.toContain(oldSecret);
    expect(audited).not.toContain(newSecret);
  });

  it("re-enables without rotating when no rotation is asked for", async () => {
    const response = await PATCH(request("/webhooks/id", "PATCH"), context);
    expect(response.status).toBe(200);
    expect((await response.json()).subscription.signingSecret).toBeUndefined();
    expect(db.webhookSubscription.update.mock.calls[0][0].data).toEqual({
      enabled: true,
      disabledAt: null,
      failureCount: 0,
    });
  });

  it("rejects a malformed rotation body, and only after the key is accepted", async () => {
    const response = await PATCH(
      request("/webhooks/id", "PATCH", { rotateSecret: "yes" }),
      context,
    );
    expect(response.status).toBe(400);
    expect(db.webhookSubscription.update).not.toHaveBeenCalled();

    // An anonymous caller must not be able to tell a bad body from a good one.
    const anonymous = await PATCH(
      request("/webhooks/id", "PATCH", { rotateSecret: "yes" }, false),
      context,
    );
    expect(anonymous.status).toBe(401);
  });

  it("will not rotate a subscription the agent does not own", async () => {
    db.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    const response = await PATCH(
      request("/webhooks/id", "PATCH", { rotateSecret: true }),
      context,
    );
    expect(response.status).toBe(404);
    expect(db.webhookSubscription.update).not.toHaveBeenCalled();
  });
});
