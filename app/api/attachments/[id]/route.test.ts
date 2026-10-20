import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(),
}));

const tenantAccessFor = vi.hoisted(() =>
  vi.fn(async () => ({
    tenantId: "tenant-ziki",
    tenantName: "Ziki",
    tenantSlug: "ziki",
    membershipRole: "member" as "owner" | "admin" | "member",
    admin: false,
  })),
);
vi.mock("@/lib/tenant-access", () => ({ tenantAccessFor }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membership: { findUnique: vi.fn() },
    attachment: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { GET, DELETE } from "./route";

const userMock = vi.mocked(requireUser) as unknown as ReturnType<typeof vi.fn>;
const findUnique = vi.mocked(prisma.attachment.findUnique) as unknown as ReturnType<typeof vi.fn>;
const attachmentDelete = vi.mocked(prisma.attachment.delete) as unknown as ReturnType<typeof vi.fn>;
const membershipFindUnique = vi.mocked(prisma.membership.findUnique) as unknown as ReturnType<typeof vi.fn>;

function makeRequest(id: string) {
  return GET(new NextRequest(`http://localhost:3000/api/attachments/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/attachments/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userMock.mockResolvedValue({ id: "user-1", role: "user" });
  });

  it("returns 404 if attachment is not found", async () => {
    findUnique.mockResolvedValue(null);
    const res = await makeRequest("missing-id");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  it("returns 404 if attachment is unlinked and uploader is someone else", async () => {
    findUnique.mockResolvedValue({
      uploaderId: "user-2",
      filename: "secret.pdf",
      contentType: "application/pdf",
      size: 100,
      data: Buffer.from("pdf-data"),
      bug: null,
    });
    const res = await makeRequest("att-1");
    expect(res.status).toBe(404);
  });

  it("returns 200 if attachment is unlinked but uploader is current user", async () => {
    findUnique.mockResolvedValue({
      uploaderId: "user-1",
      filename: "my-draft.log",
      contentType: "text/plain; charset=utf-8",
      size: 10,
      data: Buffer.from("log-content"),
      bug: null,
    });
    const res = await makeRequest("att-1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("log-content");
    expect(res.headers.get("Content-Disposition")).toContain('filename="my-draft.log"');
  });

  it("returns 404 if attachment belongs to a deleted issue and user is not admin", async () => {
    userMock.mockResolvedValue({ id: "user-1", role: "user" });
    findUnique.mockResolvedValue({
      uploaderId: "user-1",
      filename: "issue.png",
      contentType: "image/png",
      size: 50,
      data: Buffer.from("png-bytes"),
      bug: { isDeleted: true },
    });
    const res = await makeRequest("att-2");
    expect(res.status).toBe(404);
  });

  it("returns 404 when a site admin is only a member of the issue's organization", async () => {
    userMock.mockResolvedValue({ id: "admin-1", role: "admin" });
    findUnique.mockResolvedValue({
      uploaderId: "user-2",
      filename: "issue.png",
      contentType: "image/png",
      size: 50,
      data: Buffer.from("png-bytes"),
      bug: { isDeleted: true, tenantId: "tenant-ziki" },
    });
    const res = await makeRequest("att-2");
    expect(res.status).toBe(404);
  });

  it("returns 200 if an owner of the organization requests a file on a deleted issue", async () => {
    userMock.mockResolvedValue({ id: "admin-1", role: "user" });
    tenantAccessFor.mockResolvedValueOnce({
      tenantId: "tenant-ziki",
      tenantName: "Ziki",
      tenantSlug: "ziki",
      membershipRole: "owner",
      admin: true,
    });
    findUnique.mockResolvedValue({
      uploaderId: "user-2",
      filename: "issue.png",
      contentType: "image/png",
      size: 50,
      data: Buffer.from("png-bytes"),
      bug: { isDeleted: true, tenantId: "tenant-ziki" },
    });
    const res = await makeRequest("att-2");
    expect(res.status).toBe(200);
  });

  it("returns 200 for normal user if attachment belongs to an active issue", async () => {
    userMock.mockResolvedValue({ id: "user-3", role: "user" });
    findUnique.mockResolvedValue({
      uploaderId: "user-2",
      filename: "screenshot.webp",
      contentType: "image/webp",
      size: 100,
      data: Buffer.from("webp-bytes"),
      bug: { isDeleted: false },
    });
    const res = await makeRequest("att-3");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("serves a proposal mockup only to members of its tenant", async () => {
    userMock.mockResolvedValue({ id: "user-3", role: "user" });
    findUnique.mockResolvedValue({
      uploaderId: "user-2", filename: "mockup.png", contentType: "image/png", size: 50,
      data: Buffer.from("png-bytes"), bug: null, redesignProposal: { tenantId: "tenant-1" },
    });
    membershipFindUnique.mockResolvedValue({ userId: "user-3" });
    expect((await makeRequest("att-proposal")).status).toBe(200);
    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: "tenant-1", userId: "user-3" } }, select: { userId: true },
    });
    membershipFindUnique.mockResolvedValueOnce(null);
    expect((await makeRequest("att-proposal")).status).toBe(404);
  });
});

describe("DELETE /api/attachments/[id] (#658)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userMock.mockResolvedValue({ id: "user-1", role: "user" });
  });

  function makeDeleteRequest(id: string) {
    return DELETE(new NextRequest(`http://localhost:3000/api/attachments/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
  }

  it("returns 404 when attachment does not exist", async () => {
    findUnique.mockResolvedValue(null);
    const res = await makeDeleteRequest("missing-id");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
    expect(attachmentDelete).not.toHaveBeenCalled();
  });

  it("allows uploader to delete an unattached upload when abandoning form", async () => {
    findUnique.mockResolvedValue({
      id: "att-1",
      uploaderId: "user-1",
      bugId: null,
      commentId: null,
      redesignProposalId: null,
      bug: null,
      comment: null,
      redesignProposal: null,
    });
    attachmentDelete.mockResolvedValue({ id: "att-1" });

    const res = await makeDeleteRequest("att-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(attachmentDelete).toHaveBeenCalledWith({ where: { id: "att-1" } });
  });

  it("returns 403 when a non-uploader non-admin user tries to delete an attachment", async () => {
    findUnique.mockResolvedValue({
      id: "att-2",
      uploaderId: "other-user",
      bugId: "bug-1",
      commentId: null,
      redesignProposalId: null,
      bug: { tenantId: "tenant-ziki" },
      comment: null,
      redesignProposal: null,
    });

    const res = await makeDeleteRequest("att-2");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(attachmentDelete).not.toHaveBeenCalled();
  });

  it("allows tenant admin to delete an attachment", async () => {
    tenantAccessFor.mockResolvedValueOnce({
      tenantId: "tenant-ziki",
      tenantName: "Ziki",
      tenantSlug: "ziki",
      membershipRole: "admin",
      admin: true,
    });
    findUnique.mockResolvedValue({
      id: "att-2",
      uploaderId: "other-user",
      bugId: "bug-1",
      commentId: null,
      redesignProposalId: null,
      bug: { tenantId: "tenant-ziki" },
      comment: null,
      redesignProposal: null,
    });
    attachmentDelete.mockResolvedValue({ id: "att-2" });

    const res = await makeDeleteRequest("att-2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(attachmentDelete).toHaveBeenCalledWith({ where: { id: "att-2" } });
  });
});

