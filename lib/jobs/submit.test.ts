import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => vi.fn());
const createJobReviewOffers = vi.hoisted(() => vi.fn());

const db = vi.hoisted(() => ({
  job: { findFirst: vi.fn() },
  jobSubmission: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("./review", () => ({ createJobReviewOffers }));

import { submitJobRow } from "./submit";

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

const job = {
  id: "job1",
  tenantId: "tenant1",
  projectId: "project1",
  dedupeKey: "url",
  maxSubmissions: 2,
  pointsPerAccepted: 5,
  submissionSchema: { properties: { url: { type: "string" } }, required: ["url"] },
};

const submission = { id: "sub1", jobId: "job1", reviewsNeeded: 2, status: "pending" };

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.job.findFirst.mockResolvedValue(job);
  db.jobSubmission.findFirst.mockResolvedValue(null);
  db.jobSubmission.count.mockResolvedValue(0);
  db.jobSubmission.create.mockResolvedValue(submission);
  db.jobSubmission.update.mockImplementation(async ({ data }: { data: object }) => ({ ...submission, ...data }));
  createJobReviewOffers.mockResolvedValue(2);
});

describe("submitJobRow (#617)", () => {
  it("creates a pending row and records the reviews needed", async () => {
    const result = await submitJobRow(agent, "job1", { data: { url: "https://x.dev" } });
    expect(result.id).toBe("sub1");
    expect(db.jobSubmission.create).toHaveBeenCalled();
    expect(createJobReviewOffers).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(agent, "job.submitted", "sub1", { jobId: "job1" }, { db });
  });

  it("rejects a duplicate dedupeKey with 409", async () => {
    db.jobSubmission.findFirst.mockResolvedValue({ id: "existing" });
    await expect(submitJobRow(agent, "job1", { data: { url: "https://x.dev" } })).rejects.toMatchObject({
      status: 409,
    });
    expect(db.jobSubmission.create).not.toHaveBeenCalled();
  });

  it("enforces maxSubmissions with 409", async () => {
    db.jobSubmission.count.mockResolvedValue(2);
    await expect(submitJobRow(agent, "job1", { data: { url: "https://x.dev" } })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects a row that violates the schema with 422", async () => {
    await expect(submitJobRow(agent, "job1", { data: {} })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a missing dedupe value with 422", async () => {
    await expect(
      submitJobRow(agent, "job1", { data: { url: "" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("404s for a job in another tenant", async () => {
    db.job.findFirst.mockResolvedValue(null);
    await expect(submitJobRow(agent, "job1", { data: { url: "https://x.dev" } })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("updates reviewsNeeded when fewer reviewers exist than the default", async () => {
    createJobReviewOffers.mockResolvedValue(1);
    const result = await submitJobRow(agent, "job1", { data: { url: "https://x.dev" } });
    expect(db.jobSubmission.update).toHaveBeenCalledWith({
      where: { id: "sub1" },
      data: { reviewsNeeded: 1 },
    });
    expect(result).toMatchObject({ reviewsNeeded: 1 });
  });
});
