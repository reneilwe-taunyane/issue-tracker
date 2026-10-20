import type { JobSubmissionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/issues";
import { audit } from "@/lib/agents/audit";
import { publish } from "@/lib/agent-api/events";
import { award } from "@/lib/points/award";
import { jobSubmissionSourceKey } from "@/lib/points/rules";
import {
  DEFAULT_REVIEW_VERDICTS_NEEDED,
  REVIEW_DEADLINE_MS,
  REVIEW_OFFER_TTL_MS,
  isReviewDeadlineExpired,
  isReviewOfferExpired,
  rankReviewOfferCandidates,
  type ReviewOfferCandidate,
} from "@/lib/agent-api/review-offer";
import { jobReviewSchema, type JobReviewInput } from "@/lib/validations/job";

/**
 * The job review loop (#617). It mirrors the pull-request review-offer
 * mechanics (#597) — accept an offer, then leave a verdict — but is deliberately
 * separate so the bug flow stays untouched.
 *
 * A submission is accepted once `reviewsNeeded` owners (distinct from the
 * submitter's owner) accept it; any reject vetoes it immediately. The submitter's
 * owner is paid exactly once via the idempotent `sourceKey`.
 */

type Db = typeof prisma | Prisma.TransactionClient;

const OFFER_STATUSES = ["offered", "accepted", "completed"] as const;

export type JobForReview = {
  id: string;
  tenantId: string;
  projectId: string;
  pointsPerAccepted: number;
};

export type SubmissionForReview = {
  id: string;
  jobId: string;
  agentId: string;
  beneficiaryUserId: string;
  reviewsNeeded: number;
};

type Candidate = ReviewOfferCandidate & { agentId: string };

/**
 * Finds distinct people with an active agent who may review this submission.
 * Independence is on the owner (#442): a person can't review a row their own
 * agent — or another of their agents — submitted.
 */
async function findEligibleReviewers(
  db: Db,
  tenantId: string,
  submission: SubmissionForReview,
  excludeUserIds: Set<string>,
): Promise<Candidate[]> {
  const memberships = await db.membership.findMany({
    where: {
      tenantId,
      user: {
        agents: {
          some: { tenantId, revokedAt: null, level: { in: ["reviewer", "merger"] } },
        },
      },
    },
    select: {
      userId: true,
      user: {
        select: {
          agents: {
            where: { tenantId, revokedAt: null, level: { in: ["reviewer", "merger"] } },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  const people = memberships.flatMap((membership) => {
    const agent = membership.user.agents[0];
    if (!agent) return [];
    if (membership.userId === submission.beneficiaryUserId) return [];
    if (excludeUserIds.has(membership.userId)) return [];
    return [{ beneficiaryUserId: membership.userId, agentId: agent.id }];
  });
  if (!people.length) return [];

  const userIds = people.map((p) => p.beneficiaryUserId);
  const activeOffers = await db.jobReviewOffer.groupBy({
    by: ["beneficiaryUserId"],
    where: {
      beneficiaryUserId: { in: userIds },
      status: { in: ["offered", "accepted"] },
    },
    _count: { _all: true },
  });
  const offerCounts = new Map(activeOffers.map((r) => [r.beneficiaryUserId, r._count._all]));

  const candidates: Candidate[] = people.map((p) => ({
    ...p,
    activeWorkload: offerCounts.get(p.beneficiaryUserId) ?? 0,
    lastOfferedAt: null,
  }));

  return rankReviewOfferCandidates(candidates);
}

/**
 * Offers a new submission to independent reviewers and records how many accepts
 * it needs (#617). Returns the number of distinct reviewers already holding an
 * offer (the threshold), or the default of 2 when nobody is available.
 */
export async function createJobReviewOffers(
  db: Db,
  caller: { agentId?: string; tenantId: string },
  job: JobForReview,
  submission: SubmissionForReview,
): Promise<number> {
  const candidates = await findEligibleReviewers(db, job.tenantId, submission, new Set());

  if (!candidates.length) {
    // Nobody can review yet. Still 2, so a late reviewer must reach quorum.
    return DEFAULT_REVIEW_VERDICTS_NEEDED;
  }

  const selected = candidates.slice(0, DEFAULT_REVIEW_VERDICTS_NEEDED);
  const now = new Date();

  for (const reviewer of selected) {
    const offer = await db.jobReviewOffer.create({
      data: {
        submissionId: submission.id,
        agentId: reviewer.agentId,
        beneficiaryUserId: reviewer.beneficiaryUserId,
        status: "offered",
        offeredAt: now,
      },
    });

    const expiresAt = new Date(now.getTime() + REVIEW_OFFER_TTL_MS).toISOString();
    await publish(db, {
      tenantId: job.tenantId,
      type: "job.review.requested",
      actorAgentId: caller.agentId ?? null,
      payload: {
        offerId: offer.id,
        jobId: job.id,
        submissionId: submission.id,
        agentId: reviewer.agentId,
        beneficiaryUserId: reviewer.beneficiaryUserId,
        expiresAt,
      },
    });
  }

  return Math.min(selected.length, DEFAULT_REVIEW_VERDICTS_NEEDED);
}

/** Accepts a pending job review offer (#617), mirroring the PR flow's TTLs. */
export async function acceptJobReviewOffer(agent: AgentContext, offerId: string) {
  return prisma.$transaction(async (tx) => {
    const offer = await tx.jobReviewOffer.findUnique({
      where: { id: offerId },
      include: { submission: { select: { job: { select: { tenantId: true } } } } },
    });
    if (!offer || offer.submission.job.tenantId !== agent.tenantId) {
      throw new IssueApiError(404, "Review offer not found.");
    }
    if (offer.agentId !== agent.agentId) {
      throw new IssueApiError(409, "This review offer was made to another agent.");
    }

    const now = new Date();
    if (offer.status === "expired" || isReviewOfferExpired(offer.offeredAt, now.getTime())) {
      if (offer.status !== "expired") {
        await tx.jobReviewOffer.update({
          where: { id: offer.id },
          data: { status: "expired", expiredAt: now },
        });
      }
      throw new IssueApiError(410, "This review offer expired.");
    }
    if (offer.status !== "offered") {
      throw new IssueApiError(409, `This review offer is already ${offer.status}.`);
    }

    const updated = await tx.jobReviewOffer.update({
      where: { id: offer.id },
      data: {
        status: "accepted",
        acceptedAt: now,
        deadlineAt: new Date(now.getTime() + REVIEW_DEADLINE_MS),
      },
    });

    await audit(agent, "job.review.offer_accepted", offer.id, {}, { db: tx });
    return { offer: updated };
  });
}

export type ReviewOutcome = {
  submission: { id: string; status: string; reviewsNeeded: number };
  review: { id: string; verdict: string };
  points_awarded: number;
};

/**
 * Records a reviewer's verdict on a submission (#617).
 *
 * The caller must hold an accepted offer for this row (accept it first), be a
 * reviewer, and not be the submitter's owner. A reject vetoes immediately; an
 * accept counts toward `reviewsNeeded` distinct owners, and reaching it accepts
 * the row and pays the submitter's owner once.
 */
export async function reviewJobSubmission(
  agent: AgentContext,
  submissionId: string,
  input: JobReviewInput,
): Promise<ReviewOutcome> {
  const parsed = jobReviewSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const submission = await tx.jobSubmission.findUnique({
      where: { id: submissionId },
      include: { job: { select: { id: true, tenantId: true, projectId: true, pointsPerAccepted: true } } },
    });
    if (!submission || submission.job.tenantId !== agent.tenantId) {
      throw new IssueApiError(404, "Submission not found.");
    }
    if (submission.beneficiaryUserId === agent.ownerId) {
      throw new IssueApiError(409, "An agent cannot review a row its own owner submitted.");
    }

    const existingReview = await tx.jobReview.findFirst({
      where: { submissionId, agentId: agent.agentId },
      select: { id: true },
    });
    if (existingReview) {
      throw new IssueApiError(409, "This agent has already reviewed this submission.");
    }

    const offer = await tx.jobReviewOffer.findFirst({
      where: { submissionId, agentId: agent.agentId, status: "accepted" },
      select: { id: true, deadlineAt: true },
    });
    if (!offer) {
      throw new IssueApiError(409, "Accept this submission's review offer before leaving a verdict.");
    }
    if (isReviewDeadlineExpired(offer.deadlineAt)) {
      throw new IssueApiError(410, "The review deadline passed.");
    }

    if (submission.status !== "pending") {
      throw new IssueApiError(409, `This submission is already ${submission.status}.`);
    }

    const review = await tx.jobReview.create({
      data: {
        submissionId,
        agentId: agent.agentId,
        beneficiaryUserId: agent.ownerId,
        verdict: parsed.verdict,
        notes: parsed.notes ?? null,
      },
      select: { id: true, verdict: true },
    });

    await tx.jobReviewOffer.update({
      where: { id: offer.id },
      data: { status: "completed", completedAt: new Date() },
    });

    let status: JobSubmissionStatus = submission.status;
    let pointsAwarded = 0;

    if (parsed.verdict === "reject") {
      status = "rejected";
    } else {
      const accepts = await tx.jobReview.findMany({
        where: { submissionId, verdict: "accept" },
        select: { beneficiaryUserId: true },
      });
      const distinctOwners = new Set(accepts.map((a) => a.beneficiaryUserId));
      if (distinctOwners.size >= submission.reviewsNeeded) {
        status = "accepted";
        const written = await award(tx, {
          tenantId: submission.job.tenantId,
          userId: submission.beneficiaryUserId,
          bugId: null,
          role: "submission",
          points: submission.job.pointsPerAccepted,
          sourceKey: jobSubmissionSourceKey(submission.job.id, submission.id),
        });
        if (written) pointsAwarded = submission.job.pointsPerAccepted;
      }
    }

    const updated = await tx.jobSubmission.update({
      where: { id: submissionId },
      data: status === "pending" ? {} : { status, reviewedAt: new Date() },
    });

    await audit(agent, "job.submission.reviewed", review.id, { submissionId, status }, { db: tx });
    await publish(tx, {
      tenantId: submission.job.tenantId,
      type: "job.submission.reviewed",
      actorAgentId: agent.agentId,
      payload: {
        jobId: submission.job.id,
        submissionId,
        reviewId: review.id,
        verdict: parsed.verdict,
        status,
      },
    });

    return {
      submission: { id: updated.id, status: updated.status, reviewsNeeded: updated.reviewsNeeded },
      review,
      points_awarded: pointsAwarded,
    };
  });
}

export { OFFER_STATUSES };
