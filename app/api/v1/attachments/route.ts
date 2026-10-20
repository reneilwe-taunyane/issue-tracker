import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { prisma } from "@/lib/prisma";
import { MAX_ATTACHMENT_BYTES, checkAttachment } from "@/lib/attachments";
import { pruneUnlinkedUploads } from "@/lib/attachment-retention";

export const runtime = "nodejs";

/** Room for the multipart boundary and headers around one 5 MB file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * POST /api/v1/attachments — an agent uploads a screenshot, log, PDF or HAR
 * file (#645). Multipart form with one `file` field. Contributor+, charged to
 * the write budget and audited.
 *
 * The same checks as the web upload (`checkAttachment`): the bytes decide the
 * type (PNG, JPEG, GIF, WebP, PDF, or text/JSON/HAR), never the name or the
 * declared type, so SVG and HTML are refused; 5 MB at most. The file is stored
 * unlinked, owned by the agent's owner, until an issue or comment created with
 * `attachmentIds: [id]` claims it. Unlinked uploads expire after 7 days (#543).
 *
 * 201 `{ id, filename, contentType, size }`.
 */
export async function POST(request: NextRequest) {
  return agentIssueRequest(request, "attachments.upload", "contributor", null, async (agent) => {
    // Refuse an obviously oversized body before reading it into memory.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return NextResponse.json({ error: "Over 5 MB. Try a smaller file." }, { status: 413 });
    }

    let file: FormDataEntryValue | null;
    try {
      file = (await request.formData()).get("file");
    } catch {
      return NextResponse.json({ error: "Send a multipart/form-data body with a `file` field." }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Send the file in a `file` field." }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkAttachment(bytes, file.name);
    if (!check.ok) {
      const tooBig = bytes.byteLength > MAX_ATTACHMENT_BYTES;
      return NextResponse.json({ error: check.error }, { status: tooBig ? 413 : bytes.byteLength === 0 ? 400 : 415 });
    }

    try {
      const saved = await prisma.attachment.create({
        data: {
          uploaderId: agent.ownerId,
          filename: check.filename,
          contentType: check.contentType,
          size: bytes.byteLength,
          data: Buffer.from(bytes),
        },
        select: { id: true, filename: true, contentType: true, size: true },
      });
      await pruneUnlinkedUploads(prisma, { uploaderId: agent.ownerId }).catch((error: unknown) =>
        console.error("[agent-uploads] cleanup of unlinked uploads failed", error),
      );
      return NextResponse.json(saved, { status: 201 });
    } catch {
      return NextResponse.json({ error: "Attachment storage unavailable." }, { status: 503 });
    }
  });
}
