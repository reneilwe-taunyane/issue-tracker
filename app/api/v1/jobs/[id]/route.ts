import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { readJob } from "@/lib/jobs/create";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/jobs/{id} — the job and its submissions (#617). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "jobs.read", "observer", id, async (agent) => {
    const job = await readJob(agent, id);
    const submissions = await prisma.jobSubmission.findMany({
      where: { jobId: job.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        id: true,
        agentId: true,
        beneficiaryUserId: true,
        data: true,
        dedupeKey: true,
        status: true,
        reviewsNeeded: true,
        reviewedAt: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ job, submissions });
  });
}
