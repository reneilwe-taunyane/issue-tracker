import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(),
  budget: vi.fn(),
  createJob: vi.fn(),
  listJobs: vi.fn(),
  readJob: vi.fn(),
  submitJobRow: vi.fn(),
  acceptJobReviewOffer: vi.fn(),
  reviewJobSubmission: vi.fn(),
}));

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  job: { findFirst: vi.fn() },
  jobSubmission: { findMany: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
}));

vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));

vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: mocks.budget,
  agentBudgetExceededResponse: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));

vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));
vi.mock("@/lib/jobs/create", () => ({ createJob: mocks.createJob, listJobs: mocks.listJobs, readJob: mocks.readJob }));
vi.mock("@/lib/jobs/submit", () => ({ submitJobRow: mocks.submitJobRow }));
vi.mock("@/lib/jobs/review", () => ({
  acceptJobReviewOffer: mocks.acceptJobReviewOffer,
  reviewJobSubmission: mocks.reviewJobSubmission,
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { GET as listGET, POST as createPOST } from "./route";
import { GET as readGET } from "./[id]/route";
import { POST as submitPOST } from "./[id]/submissions/route";
import { POST as acceptPOST } from "./reviews/[id]/accept/route";
import { POST as verdictPOST } from "./submissions/[id]/reviews/route";
import { IssueApiError } from "@/lib/agent-api/issues";

const agent = {
  agentId: "agent1",
  name: "Ada's Claude",
  ownerId: "user1",
  tenantId: "tenant1",
  level: "contributor" as const,
  burst: false,
  keyId: "k1",
  projectId: null,
};

function request(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAgent.mockResolvedValue(agent);
  mocks.budget.mockResolvedValue({ allowed: true });
  db.project.findFirst.mockResolvedValue({ id: "project1" });
  db.job.findFirst.mockResolvedValue({ id: "job1", tenantId: "tenant1", projectId: "project1" });
  db.agentAuditEvent.create.mockResolvedValue({});
  mocks.createJob.mockResolvedValue({ id: "job1" });
  mocks.listJobs.mockResolvedValue([]);
  mocks.readJob.mockResolvedValue({ id: "job1", tenantId: "tenant1", projectId: "project1" });
  mocks.submitJobRow.mockResolvedValue({ id: "sub1" });
  mocks.acceptJobReviewOffer.mockResolvedValue({ offer: { id: "offer1", status: "accepted" } });
  mocks.reviewJobSubmission.mockResolvedValue({
    submission: { id: "sub1", status: "accepted" },
    review: { id: "review1", verdict: "accept" },
    points_awarded: 10,
  });
});

describe("POST /api/v1/jobs (#617)", () => {
  it("creates a job with 201", async () => {
    const res = await createPOST(
      request("http://localhost/api/v1/jobs?projectId=project1", {
        brief: "Collect every public API endpoint and its documentation URL.",
        dedupeKey: "url",
        maxSubmissions: 10,
        pointsPerAccepted: 5,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ job: { id: "job1" } });
  });

  it("400s on an invalid body", async () => {
    const res = await createPOST(request("http://localhost/api/v1/jobs?projectId=project1", { brief: "x" }));
    expect(res.status).toBe(400);
  });

  it("403s for an observer", async () => {
    mocks.requireAgent.mockResolvedValue({ ...agent, level: "observer" });
    const res = await createPOST(request("http://localhost/api/v1/jobs?projectId=project1", { brief: "x" }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/jobs (#617)", () => {
  it("lists the project's jobs", async () => {
    const res = await listGET(request("http://localhost/api/v1/jobs?projectId=project1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
  });
});

describe("GET /api/v1/jobs/[id] (#617)", () => {
  it("returns the job and submissions", async () => {
    db.jobSubmission.findMany.mockResolvedValue([]);
    const res = await readGET(request("http://localhost/api/v1/jobs/job1?projectId=project1"), {
      params: Promise.resolve({ id: "job1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job: { id: "job1" }, submissions: [] });
  });
});

describe("POST /api/v1/jobs/[id]/submissions (#617)", () => {
  it("adds a row with 201", async () => {
    const res = await submitPOST(
      request("http://localhost/api/v1/jobs/job1/submissions?projectId=project1", { data: { url: "x" } }),
      { params: Promise.resolve({ id: "job1" }) },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ submission: { id: "sub1" } });
  });

  it("propagates duplicate and cap errors as 409", async () => {
    mocks.submitJobRow.mockRejectedValueOnce(new IssueApiError(409, "duplicate"));
    const res = await submitPOST(
      request("http://localhost/api/v1/jobs/job1/submissions?projectId=project1", { data: { url: "x" } }),
      { params: Promise.resolve({ id: "job1" }) },
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /api/v1/jobs/reviews/[id]/accept (#617)", () => {
  it("accepts an offer for a reviewer", async () => {
    mocks.requireAgent.mockResolvedValue({ ...agent, level: "reviewer" });
    const res = await acceptPOST(request("http://localhost/api/v1/jobs/reviews/offer1/accept"), {
      params: Promise.resolve({ id: "offer1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offer: { id: "offer1", status: "accepted" } });
  });

  it("403s a contributor", async () => {
    const res = await acceptPOST(request("http://localhost/api/v1/jobs/reviews/offer1/accept"), {
      params: Promise.resolve({ id: "offer1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/jobs/submissions/[id]/reviews (#617)", () => {
  it("records a verdict", async () => {
    mocks.requireAgent.mockResolvedValue({ ...agent, level: "reviewer" });
    const res = await verdictPOST(
      request("http://localhost/api/v1/jobs/submissions/sub1/reviews", { verdict: "accept" }),
      { params: Promise.resolve({ id: "sub1" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ points_awarded: 10 });
  });

  it("400s an invalid verdict", async () => {
    mocks.requireAgent.mockResolvedValue({ ...agent, level: "reviewer" });
    const res = await verdictPOST(
      request("http://localhost/api/v1/jobs/submissions/sub1/reviews", { verdict: "maybe" }),
      { params: Promise.resolve({ id: "sub1" }) },
    );
    expect(res.status).toBe(400);
  });
});
