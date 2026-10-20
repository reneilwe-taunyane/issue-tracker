import { describe, expect, it, vi } from "vitest";
import { gettingStartedFor, parseDismissed, withDismissed } from "./onboarding";

function db(counts: { projects: number; issues: number; members: number; invites: number }) {
  return {
    project: { count: vi.fn(async () => counts.projects) },
    bug: { count: vi.fn(async () => counts.issues) },
    membership: { count: vi.fn(async () => counts.members) },
    tenantInvite: { count: vi.fn(async () => counts.invites) },
  };
}

describe("getting-started checklist (#641)", () => {
  it("starts a brand-new workspace with only the workspace (and its first project) done", async () => {
    const { steps, complete } = await gettingStartedFor(db({ projects: 1, issues: 0, members: 1, invites: 0 }) as never, "t1", { tenantSlug: "acme" });
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ["workspace", true],
      ["project", true],
      ["issue", false],
      ["invite", false],
    ]);
    expect(complete).toBe(false);
    expect(steps.find((s) => s.id === "invite")?.href).toBe("/tenants/acme");
  });

  it("counts a pending invite as inviting a teammate, and finishes when all are done", async () => {
    const result = await gettingStartedFor(db({ projects: 2, issues: 3, members: 1, invites: 1 }) as never, "t1", { tenantSlug: "acme" });
    expect(result.complete).toBe(true);
  });

  it("only counts live invites and this workspace's issues", async () => {
    const fake = db({ projects: 1, issues: 0, members: 1, invites: 0 });
    const now = new Date("2026-10-21T00:00:00Z");
    await gettingStartedFor(fake as never, "t1", { tenantSlug: "acme", now });
    expect(fake.tenantInvite.count).toHaveBeenCalledWith({ where: { tenantId: "t1", acceptedAt: null, expiresAt: { gt: now } } });
    expect(fake.bug.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isDeleted: false } });
  });

  it("remembers dismissals per workspace, ignores junk and stays bounded", () => {
    expect(parseDismissed(undefined)).toEqual([]);
    expect(parseDismissed("t1, <script>,t2")).toEqual(["t1", "t2"]);
    expect(withDismissed("t1,t2", "t1")).toBe("t2,t1");
    let value = "";
    for (let i = 0; i < 80; i++) value = withDismissed(value, `t${i}`);
    expect(parseDismissed(value)).toHaveLength(50);
    expect(parseDismissed(value).at(-1)).toBe("t79");
  });
});
