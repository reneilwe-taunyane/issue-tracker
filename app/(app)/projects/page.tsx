import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { activeProjectIdFor } from "@/lib/project-context";
import { currentTenantIdFor, NO_TENANT_MESSAGE } from "@/lib/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyProjectIdButton } from "./copy-project-id";
import { CreateProjectForm } from "./create-project-form";
import {
  deleteProjectAction,
  setProjectArchivedAction,
  switchProjectAction,
} from "./actions";
import { isTenantAdmin, isTenantAdminRole } from "@/lib/agents/membership";
import { MissionCoverage } from "./mission-coverage";

/* Distinct browser-tab title; the root layout appends "· Ziki Issues". */
export const metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  const user = await requireUser();
  const {
    error: errorParam,
    notice: noticeParam,
  } = await searchParams;
  const error = typeof errorParam === "string" ? errorParam : "";
  const notice = typeof noticeParam === "string" ? noticeParam : "";
  const tenantId = await currentTenantIdFor(user.id);

  if (!tenantId) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p>{NO_TENANT_MESSAGE}</p>
          <div className="mt-3">
            <Link
              href="/tenants"
              className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
            >
              Create or join a workspace &rarr;
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const canManageProjects = await isTenantAdmin(user, tenantId);

  const [tenant, projects, activeProjectId, membership] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    }),
    prisma.project.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        archivedAt: true,
        createdAt: true,
        _count: { select: { bugs: true } },
        testMissions: {
          select: {
            id: true,
            routePattern: true,
            brief: true,
            role: true,
            viewport: true,
            lastCoveredAt: true,
            issuesFiled: true,
          },
          orderBy: [{ routePattern: "asc" }, { role: "asc" }, { viewport: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    activeProjectIdFor(prisma, tenantId),
    prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      select: { role: true },
    }),
  ]);
  const isOwner = membership?.role === "owner";
  const canManageMissions = isTenantAdminRole(membership?.role, user.role);
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const archivedProjects = projects.filter((project) => project.archivedAt);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <Link href="/issues" className="text-sm text-teal-700 hover:underline">
          ← Back to issues
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
        <p className="text-sm text-slate-600">
          Projects are the products inside {tenant?.name ?? "your workspace"}.
          New issues and the issue list use the active project.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
          {notice}
        </p>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          Create a project
        </h2>
        <CreateProjectForm />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">
            Your projects
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Switching here also changes the project shown in the header.
          </p>
        </div>
        {activeProjects.length === 0 ? (
          archivedProjects.length > 0 ? (
            <p className="px-4 py-6 text-sm text-slate-600 sm:px-6">
              No active projects. Restore one below or create a new one.
            </p>
          ) : (
            <div className="space-y-2 px-4 py-6 text-sm text-slate-600 sm:px-6">
              <p className="font-medium text-slate-800">No projects yet. Create the first one above.</p>
              <p>
                Make one project per product you track, so each gets its own issues. For example, a
                software team might have <span className="font-medium">Web app</span>,{" "}
                <span className="font-medium">iOS app</span> and <span className="font-medium">Desktop app</span>;
                an agency might have one per client.
              </p>
              <p>
                Each project also gets a short id made from its name (Web app → <code>web-app</code>), used in
                links and by agents.
              </p>
            </div>
          )
        ) : (
          <ul className="divide-y divide-slate-200">
            {activeProjects.map((project) => {
              const active = project.id === activeProjectId;
              return (
                <li
                  key={project.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      <span className="truncate">{project.name}</span>
                      {active ? (
                        <Badge className="bg-teal-50 text-teal-800 ring-1 ring-teal-200">
                          Active
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {project.slug} · {project._count.bugs}{" "}
                      {project._count.bugs === 1 ? "issue" : "issues"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-500">Project ID:</span>
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                        {project.id}
                      </code>
                      <CopyProjectIdButton projectId={project.id} />
                      {canManageProjects ? (
                        <Link href={`/projects/${encodeURIComponent(project.slug)}/settings`} className="text-xs font-medium text-teal-700 hover:underline">Settings</Link>
                      ) : null}
                    </div>
                    <MissionCoverage
                      projectId={project.id}
                      canManage={canManageMissions}
                      missions={project.testMissions.map((mission) => ({
                        ...mission,
                        lastCoveredAt: mission.lastCoveredAt?.toISOString() ?? null,
                      }))}
                    />

                    {isOwner ? (
                      <details className="mt-3 text-xs text-slate-600">
                        <summary className="cursor-pointer font-medium text-slate-700">
                          Archive or delete
                        </summary>
                        <div className="mt-2 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <form action={setProjectArchivedAction}>
                            <input type="hidden" name="projectId" value={project.id} />
                            <input type="hidden" name="archived" value="true" />
                            <Button type="submit" variant="secondary">
                              Archive project
                            </Button>
                          </form>

                          <form action={deleteProjectAction} className="space-y-1">
                            <input type="hidden" name="projectId" value={project.id} />
                            <p className="font-medium text-slate-700">Delete project</p>
                            <p>
                              Only works when the project has no issues. Otherwise archive it.
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                name="confirmName"
                                placeholder={`Type ${project.name}`}
                                autoComplete="off"
                                required
                                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900"
                              />
                              <Button type="submit" variant="danger-secondary">
                                Delete project
                              </Button>
                            </div>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </div>
                  {active ? null : (
                    <form action={switchProjectAction}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <Button type="submit" variant="secondary">
                        Switch to {project.name}
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isOwner && archivedProjects.length > 0 ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-6">
            <h2 className="text-base font-semibold text-slate-900">Archived projects</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Archived projects are hidden from the switcher and can&apos;t be selected.
              Restore one to use it again.
            </p>
          </div>
          <ul className="divide-y divide-slate-200">
            {archivedProjects.map((project) => (
              <li key={project.id} className="space-y-3 px-4 py-3 sm:px-6">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                    <span className="truncate">{project.name}</span>
                    <Badge className="bg-amber-50 text-amber-800 ring-1 ring-amber-200">
                      Archived
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {project.slug} · {project._count.bugs}{" "}
                    {project._count.bugs === 1 ? "issue" : "issues"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={setProjectArchivedAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="archived" value="false" />
                    <Button type="submit" variant="secondary">
                      Restore {project.name}
                    </Button>
                  </form>
                  <form action={deleteProjectAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input
                      name="confirmName"
                      placeholder={`Type ${project.name}`}
                      autoComplete="off"
                      required
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900"
                    />
                    <Button type="submit" variant="danger-secondary">
                      Delete
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
