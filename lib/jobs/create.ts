import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/issues";
import { assertKeyProject } from "@/lib/agents/require-agent";
import { audit } from "@/lib/agents/audit";
import { publish } from "@/lib/agent-api/events";
import { createJobSchema, type CreateJobInput } from "@/lib/validations/job";

/**
 * Creating a research job (#617). Additive: nothing here touches the bug flow.
 */

type Db = typeof prisma | Prisma.TransactionClient;

export type JobRecord = Prisma.JobGetPayload<Record<string, never>>;

const jobSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  createdById: true,
  brief: true,
  submissionSchema: true,
  dedupeKey: true,
  maxSubmissions: true,
  pointsPerAccepted: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

/** Creates a job in `projectId` on behalf of the calling agent (#617). */
export async function createJob(agent: AgentContext, input: CreateJobInput): Promise<JobRecord> {
  const parsed = createJobSchema.parse(input);
  const { projectId, ...fields } = parsed;

  const project = await prisma.project.findFirst({
    where: { tenantId: agent.tenantId, ...(projectId ? { id: projectId } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, tenantId: true },
  });
  if (!project) throw new IssueApiError(404, "Project not found.");
  assertKeyProject(agent, project.id);

  return prisma.$transaction(async (tx) => {
    const job = await tx.job.create({
      data: {
        tenantId: project.tenantId,
        projectId: project.id,
        createdById: agent.ownerId,
        brief: fields.brief,
        submissionSchema: (fields.submissionSchema ?? null) as Prisma.InputJsonValue,
        dedupeKey: fields.dedupeKey,
        maxSubmissions: fields.maxSubmissions,
        pointsPerAccepted: fields.pointsPerAccepted,
      },
      select: jobSelect,
    });

    await audit(agent, "job.created", job.id, { projectId: project.id }, { db: tx });
    await publish(tx, {
      tenantId: project.tenantId,
      type: "job.created",
      actorAgentId: agent.agentId,
      payload: {
        jobId: job.id,
        projectId: project.id,
        dedupeKey: job.dedupeKey,
        maxSubmissions: job.maxSubmissions,
        pointsPerAccepted: job.pointsPerAccepted,
      },
    });
    return job;
  });
}

/** Lists a project's jobs, newest first (#617). */
export async function listJobs(tenantId: string, projectId: string, take = 50) {
  return prisma.job.findMany({
    where: { tenantId, projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: jobSelect,
  });
}

/** Loads a job scoped to the tenant, enforcing the key's project (#617). */
export async function readJob(agent: AgentContext, jobId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId: agent.tenantId },
    select: jobSelect,
  });
  if (!job) throw new IssueApiError(404, "Job not found.");
  assertKeyProject(agent, job.projectId);
  return job;
}

export async function loadJob(db: Db, tenantId: string, jobId: string) {
  return db.job.findFirst({ where: { id: jobId, tenantId }, select: jobSelect });
}
