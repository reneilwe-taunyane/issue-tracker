import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, IssueApiError, issueJson } from "@/lib/agent-api/issues";
import { submitJobRow } from "@/lib/jobs/submit";
import { submitJobSchema } from "@/lib/validations/job";

export const runtime = "nodejs";

/** POST /api/v1/jobs/{id}/submissions — add one row (#617). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "jobs.submit", "contributor", id, async (agent) => {
    const parsed = submitJobSchema.safeParse(await issueJson(request));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid submission request.", details: parsed.error.issues }, { status: 400 });
    }
    try {
      const submission = await submitJobRow(agent, id, parsed.data);
      return NextResponse.json({ submission }, { status: 201 });
    } catch (error) {
      if (error instanceof IssueApiError) throw error;
      return NextResponse.json({ error: "Could not save this submission; try again." }, { status: 503 });
    }
  });
}
