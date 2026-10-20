import type { PrismaClient } from "@prisma/client";

/**
 * The "getting started" checklist a new workspace's owner sees on the issues
 * page (#641) until every step is done or they dismiss it.
 */

export const GETTING_STARTED_COOKIE = "ziki_getting_started_dismissed";
/** Dismissals are remembered per workspace, on this device, for a year. */
export const GETTING_STARTED_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** Most workspace ids the cookie keeps, so it can't grow without bound. */
const MAX_DISMISSED = 50;

export type GettingStartedStepId = "workspace" | "project" | "issue" | "invite";

export type GettingStartedStep = {
  id: GettingStartedStepId;
  label: string;
  hint: string;
  href: string;
  done: boolean;
};

type Db = Pick<PrismaClient, "project" | "bug" | "membership" | "tenantInvite">;

/** The steps for one workspace, from four cheap counts. */
export async function gettingStartedFor(
  db: Db,
  tenantId: string,
  { tenantSlug, now = new Date() }: { tenantSlug: string; now?: Date },
): Promise<{ steps: GettingStartedStep[]; complete: boolean }> {
  const [projects, issues, members, pendingInvites] = await Promise.all([
    db.project.count({ where: { tenantId } }),
    db.bug.count({ where: { tenantId, isDeleted: false } }),
    db.membership.count({ where: { tenantId } }),
    db.tenantInvite.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: now } } }),
  ]);
  const steps: GettingStartedStep[] = [
    {
      id: "workspace",
      label: "Create your workspace",
      hint: "Your team's own space for projects, issues and people.",
      href: "/tenants",
      done: true,
    },
    {
      id: "project",
      label: "Set up a project",
      hint: "One per product you track, such as a web app or a desktop app.",
      href: "/projects",
      done: projects > 0,
    },
    {
      id: "issue",
      label: "Report the first issue",
      hint: "Say what you expected, what happened instead, and how to make it happen again.",
      href: "/issues/new",
      done: issues > 0,
    },
    {
      id: "invite",
      label: "Invite a teammate",
      hint: "Send an invite from the workspace's people page.",
      href: `/tenants/${encodeURIComponent(tenantSlug)}`,
      done: members > 1 || pendingInvites > 0,
    },
  ];
  return { steps, complete: steps.every((step) => step.done) };
}

/** Workspace ids whose checklist was dismissed on this device. */
export function parseDismissed(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .slice(-MAX_DISMISSED);
}

/** The cookie value after dismissing `tenantId`, newest last, capped. */
export function withDismissed(value: string | null | undefined, tenantId: string): string {
  const ids = parseDismissed(value).filter((id) => id !== tenantId);
  ids.push(tenantId);
  return ids.slice(-MAX_DISMISSED).join(",");
}
