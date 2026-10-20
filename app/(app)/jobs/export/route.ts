import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";
import { CSV_EOL, csvRow } from "@/lib/csv";

/**
 * CSV export of a job's accepted submissions (#617). Mirrors the issue export:
 * member-only, streamed in pages, capped, and honest when truncated.
 */
const EXPORT_LIMIT = 10_000;
const PAGE = 500;

const COLUMNS = [
  "submission_id",
  "job_id",
  "dedupe_key",
  "data",
  "submitted_by",
  "submitted_for",
  "created_at",
] as const;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() || undefined;
  const where = {
    status: "accepted" as const,
    job: { tenantId, ...(jobId ? { id: jobId } : {}) },
  };

  const encoder = new TextEncoder();
  let sent = 0;
  let cursor: string | undefined;
  let done = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow(COLUMNS)));
    },
    async pull(controller) {
      if (done) return;
      try {
        const batch = await prisma.jobSubmission.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: Math.min(PAGE, EXPORT_LIMIT - sent),
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            jobId: true,
            dedupeKey: true,
            data: true,
            beneficiaryUserId: true,
            createdAt: true,
            agent: { select: { name: true } },
          },
        });

        for (const row of batch) {
          controller.enqueue(
            encoder.encode(
              csvRow([
                row.id,
                row.jobId,
                row.dedupeKey,
                JSON.stringify(row.data),
                row.agent?.name,
                row.beneficiaryUserId,
                row.createdAt,
              ]),
            ),
          );
        }

        sent += batch.length;
        cursor = batch.at(-1)?.id;

        if (batch.length === 0 || batch.length < PAGE || sent >= EXPORT_LIMIT) {
          done = true;
          if (sent >= EXPORT_LIMIT) {
            const total = await prisma.jobSubmission.count({ where });
            if (total > sent) {
              controller.enqueue(
                encoder.encode(
                  `# Truncated at ${EXPORT_LIMIT} of ${total} accepted rows. Narrow the filter and export again.${CSV_EOL}`,
                ),
              );
            }
          }
          controller.close();
        }
      } catch (error) {
        console.error("[jobs/export] failed mid-stream", error);
        done = true;
        controller.enqueue(
          encoder.encode(`# Export failed partway through. Please try again.${CSV_EOL}`),
        );
        controller.close();
      }
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ziki-job-submissions-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
