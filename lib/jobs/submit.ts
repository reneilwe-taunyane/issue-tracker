import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { assertKeyProject } from "@/lib/agents/require-agent";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/issues";
import { submitJobSchema, type SubmitJobInput } from "@/lib/validations/job";
import type { SubmissionSchema } from "@/lib/validations/job";
import {
  dedupeValue,
  submissionViolationsMessage,
  validateSubmissionRow,
} from "@/lib/jobs/submission-schema";
import { createJobReviewOffers } from "@/lib/jobs/review";

/**
 * Submitting a row for a research job (#617). Duplicate rows are rejected on
 * the job's `dedupeKey` and a job never takes more than `maxSubmissions`.
 */

const DEDUPE_PREFIX = "job-dedupe";

export type CreatedSubmission = Prisma.JobSubmissionGetPayload<Record<string, never>>;

/**
 * Validates `input.data` against the job's schema, resolves the dedupe value,
 * and inserts one submission (#617). Throws `IssueApiError` for every rejection
 * so the route can map the status directly.
 */
export async function submitJobRow(
  agent: AgentContext,
  jobId: string,
  input: SubmitJobInput,
): Promise<CreatedSubmission> {
  const parsed = submitJobSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: jobId, tenantId: agent.tenantId },
      select: {
        id: true,
        tenantId: true,
        projectId: true,
        dedupeKey: true,
        maxSubmissions: true,
        pointsPerAccepted: true,
        submissionSchema: true,
      },
    });
    if (!job) throw new IssueApiError(404, "Job not found.");
    // A key issued for one project cannot act in another (#742).
    assertKeyProject(agent, job.projectId);

    // A caller naming another project is asking to write somewhere it isn't.
    if (parsed.projectId && parsed.projectId !== job.projectId) {
      throw new IssueApiError(422, "That job belongs to a different project.");
    }

    const row = parsed.data;
    const violations = validateSubmissionRow(job.submissionSchema as SubmissionSchema | null, row);
    if (violations.length) {
      throw new IssueApiError(422, submissionViolationsMessage(violations));
    }

    const dedupeKey = dedupeValue(row, job.dedupeKey);
    if (!dedupeKey) {
      throw new IssueApiError(
        422,
        `This job dedupes on "${job.dedupeKey}", so each row must set it to a non-empty value.`,
      );
    }

    const existing = await tx.jobSubmission.findFirst({
      where: { jobId: job.id, dedupeKey },
      select: { id: true },
    });
    if (existing) {
      throw new IssueApiError(409, `A row with this ${job.dedupeKey} was already submitted.`);
    }

    const count = await tx.jobSubmission.count({ where: { jobId: job.id } });
    if (count >= job.maxSubmissions) {
      throw new IssueApiError(409, "This job has reached its maximum number of submissions.");
    }

    const submission = await tx.jobSubmission.create({
      data: {
        jobId: job.id,
        agentId: agent.agentId,
        beneficiaryUserId: agent.ownerId,
        data: row as Prisma.InputJsonValue,
        dedupeKey,
        status: "pending",
      },
    });

    await audit(agent, "job.submitted", submission.id, { jobId: job.id }, { db: tx });

    // Offer the row to independent reviewers. This counts candidates, publishes
    // `job.review.requested`, and records how many accepts are needed.
    const reviewsNeeded = await createJobReviewOffers(tx, agent, job, submission);

    if (reviewsNeeded !== submission.reviewsNeeded) {
      return tx.jobSubmission.update({
        where: { id: submission.id },
        data: { reviewsNeeded },
      });
    }
    return submission;
  });
}

export { DEDUPE_PREFIX };
