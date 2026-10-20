import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  project: { findFirst: vi.fn() },
  bug: { findFirst: vi.fn(), update: vi.fn() },
  comment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  issueWatch: { upsert: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));

const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: budget,
}));

import { POST, GET } from "./route";

const key = {
  id: "key-a",
  revokedAt: null,
  projectId: "proj-1",
  project: { id: "proj-1" },
  agent: {
    id: "agent-a",
    name: "Agent A",
    ownerUserId: "owner-a",
    tenantId: "tenant-a",
    level: "contributor",
    burst: false,
    revokedAt: null,
    owner: { memberships: [{ tenantId: "tenant-a" }] },
  },
};

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/v1/issues/bug-1/comments?projectId=proj-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer ziki_test",
    },
    body: JSON.stringify(body),
  });
}

function getRequest(params = "") {
  return new NextRequest(`http://localhost/api/v1/issues/bug-1/comments?projectId=proj-1${params}`, {
    method: "GET",
    headers: { authorization: "Bearer ziki_test" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((run: (tx: typeof db) => unknown) => run(db));
  db.agentApiKey.findUnique.mockResolvedValue(key);
  budget.mockResolvedValue({ allowed: true });
  db.project.findFirst.mockResolvedValue({ id: "proj-1" });
  db.bug.findFirst.mockResolvedValue({
    id: "bug-1",
    title: "Bug 1",
    reporterId: "owner-a",
    assigneeId: null,
  });
  db.comment.create.mockResolvedValue({
    id: "c-1",
    bugId: "bug-1",
    authorId: "owner-a",
    agentId: "agent-a",
    body: "Here is my bid",
    parentId: null,
    type: "bid",
    metadata: { eta: "2 hours" },
    createdAt: new Date(),
  });
  db.comment.findMany.mockResolvedValue([]);
  db.agentAuditEvent.create.mockResolvedValue({});
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
});

describe("Structured Comments API (#747)", () => {
  it("creates a structured bid comment with metadata", async () => {
    const res = await POST(
      postRequest({
        body: "I bid on this issue",
        type: "bid",
        metadata: { eta: "2 hours" },
      }),
      { params: Promise.resolve({ id: "bug-1" }) },
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.comment).toMatchObject({
      id: "c-1",
      type: "bid",
      metadata: { eta: "2 hours" },
    });
    expect(db.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bid",
          metadata: { eta: "2 hours" },
        }),
      }),
    );
  });

  it("filters comments by type query param", async () => {
    db.comment.findMany.mockResolvedValue([
      {
        id: "c-delivery",
        body: "Delivered PR",
        type: "delivery",
        metadata: { prUrl: "https://github.com/pull/1" },
        authorId: "owner-a",
        agentId: "agent-a",
        parentId: null,
        createdAt: new Date(),
        editedAt: null,
        author: { id: "owner-a", name: "Ada" },
        agent: { id: "agent-a", name: "Agent A" },
      },
    ]);

    const res = await GET(getRequest("&type=delivery"), {
      params: Promise.resolve({ id: "bug-1" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].type).toBe("delivery");
    expect(db.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bugId: "bug-1",
          type: "delivery",
        }),
      }),
    );
  });
});
