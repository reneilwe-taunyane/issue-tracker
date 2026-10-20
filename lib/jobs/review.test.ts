import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => vi.fn());
const publish = vi.hoisted(() => vi.fn());
const award = vi.hoisted(() => vi.fn());

const db = vi.hoisted(() => ({
  jobSubmission: { findUnique: vi.fn(), update: vi.fn() },
  jobReview: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  jobReviewOffer: { findFirst: vi.fn(), update: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn(), create: vi.fn() },
  membership: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/points/award", () => ({ award }));

import { reviewJobSubmission } from "./review";

const agent = {
  agentId: "reviewer1",
  name: "Bob's Claude",
  ownerId: "owner-bob",
  tenantId: "tenant1",
  level: "reviewer" as const,
  burst: false,
  keyId: "k1",
  projectId: null,
};

const submission = {
  id: "sub1",
  jobId: "job1",
  agentId: "submitter",
  beneficiaryUserId: "owner-ada",
  status: "pending",
  reviewsNeeded: 2,
  job: { id: "job1", tenantId: "tenant1", projectId: "project1", pointsPerAccepted: 10 },
};

const acceptedOffer = { id: "offer1", deadlineAt: new Date(Date.now() + 60_000) };

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.jobSubmission.findUnique.mockResolvedValue(submission);
  db.jobReview.findFirst.mockResolvedValue(null);
  db.jobReviewOffer.findFirst.mockResolvedValue(acceptedOffer);
  db.jobReview.create.mockResolvedValue({ id: "review1", verdict: "accept" });
  db.jobReview.findMany.mockResolvedValue([{ beneficiaryUserId: "owner-bob" }]);
  db.jobReviewOffer.update.mockResolvedValue({});
  db.jobSubmission.update.mockImplementation(async ({ data }: { data: object }) => ({ ...submission, ...data }));
  award.mockResolvedValue(false);
});

describe("reviewJobSubmission (#617)", () => {
  it("requires an accepted offer before a verdict (409)", async () => {
    db.jobReviewOffer.findFirst.mockResolvedValue(null);
    await expect(
      reviewJobSubmission(agent, "sub1", { verdict: "accept" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("an own-owner reviewer is refused (409)", async () => {
    db.jobSubmission.findUnique.mockResolvedValue({ ...submission, beneficiaryUserId: "owner-bob" });
    await expect(reviewJobSubmission(agent, "sub1", { verdict: "accept" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("a reject vetoes the submission immediately", async () => {
    db.jobReview.create.mockResolvedValue({ id: "review1", verdict: "reject" });
    const result = await reviewJobSubmission(agent, "sub1", { verdict: "reject" });
    expect(result.submission.status).toBe("rejected");
    expect(award).not.toHaveBeenCalled();
  });

  it("accepts and pays once when distinct owners reach the threshold", async () => {
    award.mockResolvedValue(true);
    db.jobReview.findMany.mockResolvedValue([
      { beneficiaryUserId: "owner-bob" },
      { beneficiaryUserId: "owner-carol" },
    ]);
    const result = await reviewJobSubmission(agent, "sub1", { verdict: "accept" });
    expect(result.submission.status).toBe("accepted");
    expect(result.points_awarded).toBe(10);
    expect(award).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        role: "submission",
        userId: "owner-ada",
        bugId: null,
        points: 10,
        sourceKey: "job:job1:submission:sub1",
      }),
    );
  });

  it("stays pending below the threshold", async () => {
    db.jobReview.findMany.mockResolvedValue([{ beneficiaryUserId: "owner-bob" }]);
    const result = await reviewJobSubmission(agent, "sub1", { verdict: "accept" });
    expect(result.submission.status).toBe("pending");
    expect(award).not.toHaveBeenCalled();
  });

  it("pays nothing when the ledger already has the row (idempotent)", async () => {
    award.mockResolvedValue(false);
    db.jobReview.findMany.mockResolvedValue([
      { beneficiaryUserId: "owner-bob" },
      { beneficiaryUserId: "owner-carol" },
    ]);
    const result = await reviewJobSubmission(agent, "sub1", { verdict: "accept" });
    expect(result.points_awarded).toBe(0);
  });

  it("refuses a second verdict from the same agent", async () => {
    db.jobReview.findFirst.mockResolvedValue({ id: "review1" });
    await expect(reviewJobSubmission(agent, "sub1", { verdict: "accept" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("409s once the submission is already decided", async () => {
    db.jobSubmission.findUnique.mockResolvedValue({ ...submission, status: "accepted" });
    await expect(reviewJobSubmission(agent, "sub1", { verdict: "accept" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("publishes job.submission.reviewed", async () => {
    await reviewJobSubmission(agent, "sub1", { verdict: "accept" });
    expect(publish).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ type: "job.submission.reviewed", tenantId: "tenant1" }),
    );
  });
});
