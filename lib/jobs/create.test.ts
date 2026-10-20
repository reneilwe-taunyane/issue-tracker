import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => vi.fn());
const publish = vi.hoisted(() => vi.fn());

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  job: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));

import { createJob, readJob } from "./create";
import { IssueApiError } from "@/lib/agent-api/issues";

const agent = {
  agentId: "agent1",
  name: "Ada's Claude",
  ownerId: "user1",
  tenantId: "tenant1",
  level: "contributor" as const,
  burst: false,
  keyId: "k1",
  projectId: null,
};

const input = {
  brief: "Collect every public API endpoint and its documentation URL.",
  dedupeKey: "url",
  maxSubmissions: 10,
  pointsPerAccepted: 5,
};

const created = { id: "job1", ...input, tenantId: "tenant1", projectId: "project1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.project.findFirst.mockResolvedValue({ id: "project1", tenantId: "tenant1" });
  db.job.create.mockResolvedValue(created);
});

describe("createJob (#617)", () => {
  it("creates a job under the default project and publishes job.created", async () => {
    const job = await createJob(agent, input);
    expect(job).toEqual(created);
    expect(db.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant1", projectId: "project1", dedupeKey: "url" }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(agent, "job.created", "job1", { projectId: "project1" }, { db });
    expect(publish).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ type: "job.created", tenantId: "tenant1" }),
    );
  });

  it("404s when the project is not in the tenant", async () => {
    db.project.findFirst.mockResolvedValue(null);
    await expect(createJob(agent, input)).rejects.toBeInstanceOf(IssueApiError);
  });

  it("rejects a key scoped to another project (#742)", async () => {
    await expect(createJob({ ...agent, projectId: "other" }, input)).rejects.toMatchObject({
      name: "AgentProjectError",
    });
  });
});

describe("readJob (#617)", () => {
  it("returns the job", async () => {
    db.job.findFirst.mockResolvedValue(created);
    expect(await readJob(agent, "job1")).toEqual(created);
  });

  it("404s for a job in another tenant", async () => {
    db.job.findFirst.mockResolvedValue(null);
    await expect(readJob(agent, "job1")).rejects.toMatchObject({ status: 404 });
  });
});
