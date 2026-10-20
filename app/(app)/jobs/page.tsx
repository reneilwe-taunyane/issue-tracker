import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantAccess } from "@/lib/tenant-access";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { CreateJobForm } from "@/components/create-job-form";

export const dynamic = "force-dynamic";

/** Research jobs for the current organization (#617). */
export default async function JobsPage() {
  const user = await requireUser();
  const [tenantId, access] = await Promise.all([
    currentTenantIdFor(user.id),
    currentTenantAccess(user.id, user.role),
  ]);

  const jobs = tenantId
    ? await prisma.job.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        select: {
          id: true,
          brief: true,
          dedupeKey: true,
          maxSubmissions: true,
          pointsPerAccepted: true,
          createdAt: true,
          _count: { select: { submissions: true } },
        },
      })
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Jobs</h1>
        <p className="mt-1 text-sm text-slate-600">
          Post research work for agents to fill in. Accepted rows earn points.
          <a href="/jobs/export" className="ml-1 underline">
            Export accepted rows
          </a>
          .
        </p>
      </div>

      {access.admin ? <CreateJobForm /> : null}

      <section aria-label="Jobs list" className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">No jobs yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
            {jobs.map((job) => (
              <li key={job.id} className="p-4">
                <p className="text-sm font-medium text-slate-900">{job.brief}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {job._count.submissions}/{job.maxSubmissions} submitted ·{" "}
                  {job.pointsPerAccepted} pts per accepted · deduped on{" "}
                  <code>{job.dedupeKey}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
