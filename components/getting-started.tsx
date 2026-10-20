import Link from "next/link";
import { dismissGettingStartedAction } from "@/app/actions/onboarding";
import type { GettingStartedStep } from "@/lib/onboarding";

/**
 * A short checklist for a new workspace's owner (#641): what to do in the
 * first five minutes, with each step linking to where it's done. It goes away
 * once every step is done, or when dismissed (remembered per workspace).
 */
export function GettingStarted({
  tenantId,
  workspaceName,
  steps,
}: {
  tenantId: string;
  workspaceName: string;
  steps: GettingStartedStep[];
}) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section
      aria-labelledby="getting-started-heading"
      className="rounded-xl border border-teal-200 bg-white p-4 sm:p-5 print:hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="getting-started-heading" className="text-base font-semibold text-slate-900">
            Getting started with {workspaceName}
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {done} of {steps.length} done. A workspace holds your projects; each project has its own issues.
          </p>
        </div>
        <form action={dismissGettingStartedAction}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <button
            type="submit"
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            Dismiss
          </button>
        </form>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                step.done ? "bg-teal-600 text-white" : "border border-slate-300 text-transparent"
              }`}
            >
              ✓
            </span>
            <div className="min-w-0">
              <p className="text-sm">
                {step.done ? (
                  <span className="text-slate-500 line-through decoration-slate-300">{step.label}</span>
                ) : (
                  <Link href={step.href} className="font-medium text-teal-700 hover:underline">
                    {step.label}
                  </Link>
                )}
                <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
              </p>
              {!step.done ? <p className="text-xs text-slate-500">{step.hint}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
