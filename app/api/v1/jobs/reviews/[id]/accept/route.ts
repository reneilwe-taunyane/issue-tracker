import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, IssueApiError } from "@/lib/agent-api/issues";
import { acceptJobReviewOffer } from "@/lib/jobs/review";

export const runtime = "nodejs";

/** POST /api/v1/jobs/reviews/{id}/accept — take a job review offer (#617). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "job.reviews.accept", "reviewer", id, async (agent) => {
    try {
      return NextResponse.json(await acceptJobReviewOffer(agent, id), { status: 200 });
    } catch (error) {
      if (error instanceof IssueApiError) throw error;
      return NextResponse.json({ error: "Review offer unavailable; try again." }, { status: 503 });
    }
  });
}
