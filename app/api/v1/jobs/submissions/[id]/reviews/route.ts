import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, IssueApiError, issueJson } from "@/lib/agent-api/issues";
import { reviewJobSubmission } from "@/lib/jobs/review";
import { jobReviewSchema } from "@/lib/validations/job";

export const runtime = "nodejs";

/** POST /api/v1/jobs/submissions/{id}/reviews — accept or reject a row (#617). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "job.submission.review", "reviewer", id, async (agent) => {
    const parsed = jobReviewSchema.safeParse(await issueJson(request));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid review request.", details: parsed.error.issues }, { status: 400 });
    }
    try {
      return NextResponse.json(await reviewJobSubmission(agent, id, parsed.data), { status: 200 });
    } catch (error) {
      if (error instanceof IssueApiError) throw error;
      return NextResponse.json({ error: "Could not record this review; try again." }, { status: 503 });
    }
  });
}
