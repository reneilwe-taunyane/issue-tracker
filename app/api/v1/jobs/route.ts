import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { createJob, listJobs } from "@/lib/jobs/create";
import { createJobSchema } from "@/lib/validations/job";

export const runtime = "nodejs";

/** GET ?projectId= — the project's research jobs, newest first (#617). */
export async function GET(request: NextRequest) {
  return agentIssueRequest(request, "jobs.list", "observer", null, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json({ jobs: await listJobs(scope.tenantId, scope.projectId) });
  });
}

/** POST JSON with brief, dedupeKey, maxSubmissions, pointsPerAccepted, optional submissionSchema. */
export async function POST(request: NextRequest) {
  return agentIssueRequest(request, "jobs.create", "contributor", null, async (agent) => {
    const parsed = createJobSchema.safeParse(await issueJson(request));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid job request.", details: parsed.error.issues }, { status: 400 });
    }
    const scope = await issueProject(agent, request.nextUrl.searchParams, parsed.data.projectId);
    try {
      const job = await createJob(agent, { ...parsed.data, projectId: scope.projectId });
      return NextResponse.json({ job }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      return NextResponse.json({ error: "Could not create this job; try again." }, { status: 503 });
    }
  });
}
