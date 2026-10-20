import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
}));
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    jobSubmission: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  },
}));

import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const authMock = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const requireUserMock = vi.mocked(requireUser) as unknown as ReturnType<typeof vi.fn>;
const findMany = vi.mocked(prisma.jobSubmission.findMany) as unknown as ReturnType<typeof vi.fn>;

describe("GET /jobs/export (#617)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "u1" } });
    requireUserMock.mockResolvedValue({ id: "u1", role: "user" });
    findMany.mockResolvedValue([]);
  });

  it("401s when not signed in", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost:3000/jobs/export"));
    expect(res.status).toBe(401);
  });

  it("streams a CSV of accepted rows", async () => {
    findMany.mockResolvedValueOnce([
      {
        id: "sub1",
        jobId: "job1",
        dedupeKey: "https://x.dev",
        data: { url: "https://x.dev" },
        beneficiaryUserId: "u1",
        createdAt: new Date("2026-10-19T12:00:00Z"),
        agent: { name: "Ada's Claude" },
      },
    ]);

    const res = await GET(new NextRequest("http://localhost:3000/jobs/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain('filename="ziki-job-submissions-');

    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(
      "submission_id,job_id,dedupe_key,data,submitted_by,submitted_for,created_at",
    );
    expect(text).toContain("sub1,job1,https://x.dev");
    expect(text).toContain("Ada's Claude,u1");
  });

  it("filters by jobId when asked", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/jobs/export?jobId=job1"));
    await res.text();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "accepted", job: { tenantId: "tenant-zedu", id: "job1" } }),
      }),
    );
  });
});
