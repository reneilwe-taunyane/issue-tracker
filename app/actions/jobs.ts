"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { fromZodError } from "@/lib/form-errors";
import { currentTenantAccess } from "@/lib/tenant-access";
import { currentTenantIdFor, defaultProjectIdFor, NO_TENANT_MESSAGE } from "@/lib/tenant-context";
import { createJobSchema } from "@/lib/validations/job";
import { publish } from "@/lib/agent-api/events";

/**
 * Posting a research job from the web (#617), for a tenant admin. Agents post
 * through `POST /api/v1/jobs` instead.
 */

export type JobActionResult = {
  ok?: true;
  jobId?: string;
  error?: string;
  field?: string;
  fieldErrors?: Record<string, string>;
};

function parseSchema(
  raw: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw?.trim();
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "The submission schema must be valid JSON." };
  }
}

export async function createJobAction(
  _previous: JobActionResult | undefined,
  formData: FormData,
): Promise<JobActionResult> {
  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  if (!access.admin || !access.tenantId) {
    return { error: "Only an organization admin can post a job." };
  }

  const schema = parseSchema(formData.get("submissionSchema")?.toString());
  if (!schema.ok) return { error: schema.error };
  const parsed = createJobSchema.safeParse({
    brief: formData.get("brief")?.toString() ?? "",
    dedupeKey: formData.get("dedupeKey")?.toString() ?? "",
    maxSubmissions: formData.get("maxSubmissions")?.toString() ?? "",
    pointsPerAccepted: formData.get("pointsPerAccepted")?.toString() ?? "",
    submissionSchema: schema.value,
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the job details.");

  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return { error: NO_TENANT_MESSAGE };
  const projectId = await defaultProjectIdFor(prisma, tenantId);
  if (!projectId) return { error: "This organization has no project to post into yet." };

  const job = await prisma.job.create({
    data: {
      tenantId,
      projectId,
      createdById: user.id,
      brief: parsed.data.brief,
      submissionSchema: (parsed.data.submissionSchema ?? undefined) as Prisma.InputJsonValue | undefined,
      dedupeKey: parsed.data.dedupeKey,
      maxSubmissions: parsed.data.maxSubmissions,
      pointsPerAccepted: parsed.data.pointsPerAccepted,
    },
    select: { id: true },
  });

  await publish(prisma, {
    type: "job.created",
    tenantId,
    actorAgentId: null,
    payload: {
      jobId: job.id,
      projectId,
      dedupeKey: parsed.data.dedupeKey,
      maxSubmissions: parsed.data.maxSubmissions,
      pointsPerAccepted: parsed.data.pointsPerAccepted,
    },
  });

  revalidatePath("/jobs");
  return { ok: true, jobId: job.id };
}
