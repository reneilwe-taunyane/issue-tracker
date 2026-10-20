import Link from "next/link";
import { Suspense } from "react";
import type { Prisma, Severity, Status } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getIssueTypes, getPlatforms } from "@/lib/lookups";
import { activeBulkOptions, loadBulkAssignees } from "@/lib/admin-list-lookups";
import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";
import type { AppRole } from "@/lib/roles";
import { IssueFilters } from "@/components/issue-filters";
import { IssueStats } from "@/components/issue-stats";
import { Avatar } from "@/components/avatar";
import { VoteButton } from "@/components/vote-button";
import { Badge } from "@/components/ui/badge";
import {
  severityLabels,
  statusClass,
  statusLabels,
} from "@/lib/labels";
import { LocalTime } from "@/components/local-time";
import { severities, statuses } from "@/lib/validations/issue";
import { getIssueTypeBadgeClass } from "@/lib/issue-type-styles";
import { escapeSearchQuery, toSingleQueryParam } from "@/lib/search";
import {
  hasMatch,
  highlightSegments,
  markdownToPlain,
  matchSnippet,
  type Snippet,
} from "@/lib/search-snippet";
import { Highlighted, SearchSnippet } from "@/components/search-highlight";
import { formatIssueNumber, parseIssueNumberQuery } from "@/lib/issue-number";
import { isDone, resultCountText } from "@/lib/issue-state";
import { calculatePagination } from "@/lib/pagination";
import { DUPLICATES_PARAM, SHOW_DUPLICATES, duplicatesWhere, parseShowDuplicates } from "@/lib/duplicates";
import { PaginationControls } from "@/components/pagination-controls";
import { fetchVoterSummaries } from "@/lib/voter-summaries";
import { dueDateValue, MILESTONE_PARAM, milestoneParamValue, milestoneWhere, parseMilestoneFilter } from "@/lib/milestones";
import { loadMilestoneSummaries } from "@/lib/milestone-stats";
import { MilestoneProgressBar } from "@/components/milestone-progress";
import { MilestoneDue } from "@/components/milestone-due";
import { createEmptyVoterSummary } from "@/lib/voters";
import { VoterAvatars } from "@/components/voter-avatars";
import {
  bugSortDescriptions,
  getBugOrderBy,
  parseBugSort,
} from "@/lib/issues-sort";
import { canDeleteTicket } from "@/lib/ticket-deletion";
import { currentTenantAccess } from "@/lib/tenant-access";
import type { OrganizationRole } from "@/lib/organization-role";
import { defaultSortFor, mineFilterWhere, parseMineFilter } from "@/lib/mine-filter";
import { finishedWatchedWhere } from "@/lib/watching";
import { UnwatchButton, UnwatchFinishedButton } from "@/components/unwatch-button";
import {
  BulkCheckbox,
  BulkSelectionProvider,
} from "@/components/bulk-selection";
import { TAGS_PARAM, parseTagFilter, serializeTags, tagTypeIds } from "@/lib/tag-filter";
import { bugInTenant, currentTenantIdFor, isMissingTenantColumnError } from "@/lib/tenant-context";
import { activeProjectIdFor } from "@/lib/project-context";
import { RichText } from "@/components/rich-text";
import { isOrganizationAdmin } from "@/lib/organization-role";
import { cookies } from "next/headers";
import { GettingStarted } from "@/components/getting-started";
import { GETTING_STARTED_COOKIE, gettingStartedFor, parseDismissed, type GettingStartedStep } from "@/lib/onboarding";
import {
  PLATFORM_PARAM,
  parsePlatformFilter,
  platformFilterWhere,
} from "@/lib/platform-filter";

/* Distinct browser-tab title; the root layout appends "· Ziki Issues". */
export const metadata = { title: "Issues" };

type SearchParams = Promise<{
  q?: string | string[];
  status?: string | string[];
  severity?: string | string[];
  platform?: string | string[];
  sort?: string | string[];
  page?: string | string[];
  deleted?: string | string[];
  mine?: string | string[];
  tags?: string | string[];
  [key: string]: string | string[] | undefined;
}>;

function isStatus(value: string | undefined): value is Status {
  return !!value && (statuses as readonly string[]).includes(value);
}

function isSeverity(value: string | undefined): value is Severity {
  return !!value && (severities as readonly string[]).includes(value);
}

async function loadOrEmpty<T>(label: string, load: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[bugs] ${label} lookup failed`, error);
    return empty;
  }
}

function issuesQueryError(detail: string) {
  return (
    <div className="rounded-xl border border-red-200 bg-white px-6 py-10">
      <h1 className="text-xl font-semibold text-slate-900">Issues could not be loaded</h1>
      <p className="mt-2 text-sm text-slate-600">
        The issues query failed. The message below is the database error.
      </p>
      <pre className="mt-4 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-800">
        {detail}
      </pre>
    </div>
  );
}

export default async function BugsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  let userId: string | undefined;
  let effectiveRole: AppRole | null | undefined;
  let membershipRole: OrganizationRole | null = null;

  if (session?.user) {
    const user = await requireUser();
    userId = user.id;
    effectiveRole = user.role;
    membershipRole = (await currentTenantAccess(user.id, user.role)).membershipRole;
  }
  // #425: only issues in the viewer's tenant; none without a membership.
  let tenantId: string | null = null;
  let projectId: string | null = null;
  try {
    tenantId = await currentTenantIdFor(userId);
    projectId = await activeProjectIdFor(prisma, tenantId);
  } catch (error) {
    console.error("[bugs] tenant/project resolution failed", error);
  }
  const activeProject = tenantId && projectId
    ? await prisma.project.findFirst({ where: { id: projectId, tenantId }, select: { slug: true, name: true, goal: true } }).catch(() => null)
    : null;

  // #641: a short checklist for a new workspace's owner or admin, until it's
  // done or dismissed on this device.
  let gettingStarted: { tenantId: string; workspaceName: string; steps: GettingStartedStep[] } | null = null;
  if (tenantId && userId && membershipRole && isOrganizationAdmin(membershipRole, effectiveRole)) {
    try {
      const dismissed = parseDismissed((await cookies()).get(GETTING_STARTED_COOKIE)?.value);
      if (!dismissed.includes(tenantId)) {
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } });
        if (tenant) {
          const checklist = await gettingStartedFor(prisma, tenantId, { tenantSlug: tenant.slug });
          if (!checklist.complete) gettingStarted = { tenantId, workspaceName: tenant.name, steps: checklist.steps };
        }
      }
    } catch (error) {
      console.error("[bugs] getting-started checklist failed", error);
    }
  }

  const canDelete = canDeleteTicket(effectiveRole, membershipRole);
  const params = await searchParams;
  const qParam = toSingleQueryParam(params.q);
  const statusParam = toSingleQueryParam(params.status);
  const severityParam = toSingleQueryParam(params.severity);
  const sortParam = toSingleQueryParam(params.sort);
  const pageParam = toSingleQueryParam(params.page);
  const deletedParam = toSingleQueryParam(params.deleted);
  const mineFilter = parseMineFilter(params.mine);
  const isDeletedView = canDelete && deletedParam === "true";

  const currentSort = parseBugSort(sortParam, defaultSortFor(mineFilter));
  const isWatchingView = mineFilter === "watching" && !!userId;
  // #285: duplicates are hidden unless asked for, and the count says so.
  const showDuplicates = parseShowDuplicates(params[DUPLICATES_PARAM]);
  const where: Prisma.BugWhereInput = {
    ...bugInTenant(tenantId),
    ...(projectId ? { projectId } : {}),
    isDeleted: isDeletedView,
    ...mineFilterWhere(mineFilter, userId),
    ...duplicatesWhere(showDuplicates),
  };

  // Tag filter (#102): issue types picked from the search box.
  // These lookups are filters only. Each one fails on its own: Promise.all
  // used to throw away the ones that succeeded when Milestone was missing,
  // and the admin path below then queried them again outside this catch.
  const [tagTypes, platforms, milestones] = await Promise.all([
    // Cached, expired by the admin actions that change them (#297).
    loadOrEmpty("issue types", () => getIssueTypes(), []),
    // Every platform, not just active ones: a link filtered on a platform
    // that was since deactivated still has to resolve. BugFilters narrows
    // the dropdown itself.
    loadOrEmpty("platforms", () => getPlatforms(tenantId), []),
    // #289: few rows; closed ones too, so an old link still resolves.
    loadOrEmpty(
      "milestones",
      () =>
        prisma.milestone.findMany({
          select: { id: true, title: true, isClosed: true },
          orderBy: [{ isClosed: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }, { title: "asc" }],
        }),
      [],
    ),
  ]);
  const selectedMilestone = parseMilestoneFilter(params[MILESTONE_PARAM], milestones);
  const milestoneParam = milestoneParamValue(selectedMilestone);
  const selectedTags = parseTagFilter(params.tags, tagTypes);
  if (selectedTags.length > 0) {
    where.typeId = { in: tagTypeIds(selectedTags, tagTypes) };
  }
  const tagsParam = serializeTags(selectedTags.map((t) => t.name));

  if (isStatus(statusParam)) {
    where.status = statusParam;
  }
  if (isSeverity(severityParam)) {
    where.severity = severityParam;
  }
  // Platform filter: one category, or the issues with none set.
  const selectedPlatform = parsePlatformFilter(params.platform, platforms);
  Object.assign(where, platformFilterWhere(selectedPlatform));
  Object.assign(where, milestoneWhere(selectedMilestone));
  if (qParam?.trim()) {
    const q = escapeSearchQuery(qParam.trim());
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
    // "42" or "#42" should also find issue #42, which is how people quote an
    // issue to each other. Left as an OR so a title containing "42" still
    // matches too, rather than the number silently hijacking the search.
    const asNumber = parseIssueNumberQuery(qParam);
    if (asNumber !== null) where.OR.push({ number: asNumber });
  }

  let totalCount = 0;
  try {
    totalCount = await prisma.bug.count({ where });
  } catch (error) {
    console.error("[bugs] list count failed", error);
    const missingColumn = isMissingTenantColumnError(error);
    if (!tenantId) {
      // No membership: nothing to show either way (#439).
      totalCount = 0;
      if (missingColumn) {
        delete where.tenantId;
        delete where.projectId;
        where.id = { in: [] };
      }
    } else if (missingColumn) {
      // #506: never retry without the tenant filter. That used to show every
      // tenant's issues to anyone whose query error mentioned the column.
      return issuesQueryError(
        "The issue list is unavailable while the database finishes upgrading. Try again in a minute.",
      );
    } else {
      const detail = error instanceof Error ? error.message : "Could not load issues";
      return issuesQueryError(detail);
    }
  }

  const baseTenantWhere: Prisma.BugWhereInput = {
    ...bugInTenant(tenantId),
    ...(projectId ? { projectId } : {}),
    isDeleted: isDeletedView,
  };

  let statsTotal = 0;
  let statsOpen = 0;
  let statsInProgress = 0;
  let statsClosed = 0;

  try {
    const [
      totalCountAll,
      openCount,
      inProgressCount,
      closedCount,
    ] = await Promise.all([
      prisma.bug.count({ where: baseTenantWhere }),
      prisma.bug.count({ where: { ...baseTenantWhere, status: "open" } }),
      prisma.bug.count({ where: { ...baseTenantWhere, status: "in_progress" } }),
      prisma.bug.count({
        where: { ...baseTenantWhere, status: { in: ["closed", "resolved"] } },
      }),
    ]);

    statsTotal = totalCountAll;
    statsOpen = openCount;
    statsInProgress = inProgressCount;
    statsClosed = closedCount;
  } catch (error) {
    console.error("[bugs] dashboard stats/counts failed", error);
  }

  // How many the default view is hiding, so "Show duplicates" can say so.
  let hiddenDuplicates = 0;
  if (!showDuplicates) {
    try {
      hiddenDuplicates = await prisma.bug.count({
        where: { ...where, duplicateOfId: { not: null } },
      });
    } catch (error) {
      console.error("[bugs] duplicate count failed", error);
    }
  }
  const duplicatesHref = (() => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v && key !== DUPLICATES_PARAM && key !== "page") next.set(key, v);
    }
    if (!showDuplicates) next.set(DUPLICATES_PARAM, SHOW_DUPLICATES);
    const qs = next.toString();
    return qs ? `/issues?${qs}` : "/issues";
  })();

  const pagination = calculatePagination({
    page: pageParam,
    totalCount,
  });

  // Select only what the list shows: no `description` (up to 5000 chars
  // each), which the list never displays (#217).
  const listed = await prisma.bug
    .findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        severity: true,
        voteCount: true,
        proofLinks: true,
        isDeleted: true,
        isBoosted: true,
        duplicateOf: showDuplicates ? { select: { number: true } } : false,
        createdAt: true,
        updatedAt: true,
        type: { select: { name: true } },
        reporter: { select: { name: true, role: true, image: true } },
        assignee: { select: { name: true, role: true, image: true } },
        category: { select: { id: true, name: true } },
        votes: userId
          ? { where: { userId }, select: { id: true, value: true }, take: 1 }
          : false,
        _count: {
          select: {
            comments: true,
            attachments: true,
          },
        },
      },
      // A personal list reads newest-activity-first; boosts are for the shared one.
      orderBy: getBugOrderBy(currentSort, { boostFirst: !isWatchingView }),
      skip: pagination.skip,
      take: pagination.take,
    })
    .then((bugs) => ({ bugs }))
    .catch((error: unknown) => {
      console.error("[bugs] list query failed", error);
      const detail = error instanceof Error ? error.message : "Could not load issues";
      return { detail };
    });
  if ("detail" in listed) {
    return issuesQueryError(listed.detail);
  }
  const bugs = listed.bugs;

  // #301: when searching, show why a row matched. Only rows whose title
  // doesn't already contain the query need their description, so the list
  // query still never selects it (#217) and a search whose hits are all in
  // titles costs nothing extra. No search → no query at all.
  const searchText = qParam?.trim() ?? "";
  const snippets = new Map<string, Snippet>();
  if (searchText) {
    const needDescription = bugs
      .filter((bug) => !hasMatch(bug.title, searchText))
      .map((bug) => bug.id);
    if (needDescription.length > 0) {
      try {
        const rows = await prisma.bug.findMany({
          where: { id: { in: needDescription } },
          select: { id: true, description: true },
        });
        for (const row of rows) {
          const snippet = matchSnippet(markdownToPlain(row.description), searchText);
          if (snippet) snippets.set(row.id, snippet);
        }
      } catch (error) {
        // A snippet is a nicety; the results themselves are already loaded.
        console.error("[bugs] search snippets failed", error);
      }
    }
  }

  const bugIds = bugs.map((bug) => bug.id);

  // #289: filtering on one milestone shows its progress above the list.
  let milestoneSummary: Awaited<ReturnType<typeof loadMilestoneSummaries>>[number] | null = null;
  if (selectedMilestone && selectedMilestone !== "none") {
    try {
      [milestoneSummary] = await loadMilestoneSummaries({ id: selectedMilestone.id });
    } catch (error) {
      console.error("[bugs] milestone summary failed", error);
    }
  }

  // "No issues match" and "there are no issues yet" need different pages
  // (#292): filter advice on an empty tracker sends people looking for a
  // filter that is not there. The extra count only runs when the page is
  // already empty, so a populated list pays nothing for it.
  let isFirstRun = false;
  if (totalCount === 0 && !isDeletedView) {
    try {
      isFirstRun = (await prisma.bug.count({ where: { ...bugInTenant(tenantId), isDeleted: false } })) === 0;
    } catch {
      isFirstRun = false;
    }
  }

  // Only the watching view offers "stop watching the finished ones", and
  // only when there are some; everyone else pays for nothing (#312).
  let finishedWatched = 0;
  if (isWatchingView && userId) {
    try {
      finishedWatched = await prisma.bug.count({
        where: { ...finishedWatchedWhere(userId), ...bugInTenant(tenantId) },
      });
    } catch (error) {
      console.error("[bugs] finished watched count failed", error);
    }
  }

  // Only admins get bulk actions. The type and platform menus reuse the
  // lookups above, which already survived a missing table. The assignee
  // query is the one extra read, and it must not take the list down either.
  const bulkTypes = canDelete ? activeBulkOptions(tagTypes) : [];
  const bulkPlatforms = canDelete ? activeBulkOptions(platforms) : [];
  const bulkUsers = canDelete ? await loadBulkAssignees() : [];

  let voterSummaries = new Map<string, ReturnType<typeof createEmptyVoterSummary>>();
  try {
    voterSummaries = await fetchVoterSummaries(bugIds);
  } catch (error) {
    console.error("[bugs] voter summaries failed", error);
    voterSummaries = new Map();
  }

  // The key is the current query string, so changing a filter or a page
  // remounts the provider and clears the selection — which is what the bar
  // tells the user will happen.
  const selectionKey = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => {
      const single = toSingleQueryParam(v);
      return single ? [[k, single] as [string, string]] : [];
    }),
  ).toString();

  const severityDotColors: Record<string, string> = {
    critical: "bg-red-500",
    high: "bg-orange-500",
    medium: "bg-amber-500",
    low: "bg-emerald-500",
  };

  const page = (
    <div className="space-y-6">
      {gettingStarted ? <GettingStarted {...gettingStarted} /> : null}
      {activeProject?.goal ? (
        <section aria-labelledby="project-goal-heading" className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="project-goal-heading" className="text-sm font-semibold text-slate-900">{activeProject.name} goal</h2>
            {membershipRole && isOrganizationAdmin(membershipRole, effectiveRole) ? (
              <Link href={`/projects/${encodeURIComponent(activeProject.slug)}/settings`} className="text-xs font-medium text-teal-800 underline">Edit project settings</Link>
            ) : null}
          </div>
          <RichText content={activeProject.goal} className="mt-1 text-sm" />
        </section>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1
              className={
                isDeletedView
                  ? "text-xl sm:text-2xl font-bold tracking-tight text-slate-900"
                  : "text-2xl sm:text-3xl font-bold tracking-tight text-slate-900"
              }
            >
              {isDeletedView ? "Deleted Issues" : "Issues"}
            </h1>
            {isDeletedView ? (
              <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800">
                Admin view
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            Track, triage, and resolve product issues and bug reports.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {canDelete ? (
            <Link
              href={isDeletedView ? "/issues" : "/issues?deleted=true"}
              className={`inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium border transition ${
                isDeletedView
                  ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
              }`}
            >
              {isDeletedView ? "← View active issues" : "View deleted issues"}
            </Link>
          ) : null}
          {finishedWatched > 0 ? <UnwatchFinishedButton count={finishedWatched} /> : null}
          {!isDeletedView ? (
            <Link
              href="/issues/new"
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-blue-700 transition-colors"
            >
              New Issue
            </Link>
          ) : null}
        </div>
      </div>

      {!isFirstRun ? (
        <IssueStats
          total={statsTotal}
          open={statsOpen}
          inProgress={statsInProgress}
          closed={statsClosed}
        />
      ) : null}

      <div className="space-y-4">
        {isFirstRun ? null : (
          <Suspense
            fallback={<div className="h-12 animate-pulse rounded-lg bg-slate-100" />}
          >
            <IssueFilters
              tagTypes={tagTypes}
              platforms={platforms}
              milestones={milestones}
            />
          </Suspense>
        )}

          <div className="flex items-center justify-between text-xs text-slate-500">
            <p>
              {resultCountText(totalCount, isStatus(statusParam) ? statusParam : null)} · sorted by{" "}
              {bugSortDescriptions[currentSort]}
              {hiddenDuplicates > 0 || showDuplicates ? (
                <>
                  {" · "}
                  <Link href={duplicatesHref} className="font-medium text-blue-600 hover:underline print:hidden">
                    {showDuplicates
                      ? "Hide duplicates"
                      : `Show ${hiddenDuplicates} duplicate${hiddenDuplicates === 1 ? "" : "s"}`}
                  </Link>
                </>
              ) : null}
            </p>
          </div>

          {milestoneSummary ? (
            <section
              aria-label={`Milestone ${milestoneSummary.title}`}
              className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">{milestoneSummary.title}</h2>
                <MilestoneDue due={dueDateValue(milestoneSummary.dueDate) || null} isClosed={milestoneSummary.isClosed} />
                <Link href="/milestones" className="ml-auto text-sm text-blue-600 hover:underline">
                  All milestones
                </Link>
              </div>
              {milestoneSummary.description ? (
                <p className="mt-1 text-sm text-slate-600">{milestoneSummary.description}</p>
              ) : null}
              <div className="mt-3 max-w-md">
                <MilestoneProgressBar progress={milestoneSummary.progress} label={milestoneSummary.title} />
              </div>
            </section>
          ) : null}

          {isFirstRun ? (
            <FirstRunWelcome isAdmin={canDelete} hasTenant={Boolean(tenantId)} />
          ) : bugs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <p className="font-medium text-slate-800">
                {isWatchingView && !qParam && !statusParam && !severityParam && !tagsParam && !selectedPlatform && !selectedMilestone
                  ? "You're not watching any issues."
                  : "No issues match these filters."}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {isWatchingView
                  ? "You watch issues you report, are assigned to or comment on, and any you choose to watch from the issue page."
                  : "Try clearing filters or report a new issue."}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href="/issues"
                  className="text-sm font-medium text-blue-600 hover:underline"
                >
                  Clear filters
                </Link>
                <Link
                  href="/issues/new"
                  className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  New Issue
                </Link>
              </div>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
                {bugs.map((bug) => {
                  const userVote =
                    Array.isArray(bug.votes) && bug.votes.length > 0
                      ? (bug.votes[0].value ?? 1)
                      : 0;
                  const voterSummary =
                    voterSummaries.get(bug.id) ?? createEmptyVoterSummary();
                  return (
                    <li
                      key={bug.id}
                      className="group flex flex-wrap items-start gap-3.5 p-3.5 sm:p-4 md:flex-nowrap transition hover:bg-slate-50/80 has-[a[data-issue-link]:focus-visible]:bg-blue-50/60"
                    >
                      {canDelete && !isDeletedView ? (
                        <div className="pt-1">
                          <BulkCheckbox id={bug.id} title={bug.title} />
                        </div>
                      ) : null}
                      <div className="shrink-0 pt-0.5">
                        <VoteButton
                          bugId={bug.id}
                          voteCount={bug.voteCount}
                          userVote={userVote}
                          likeCount={voterSummary.likes.count}
                          dislikeCount={voterSummary.dislikes.count}
                          size="sm"
                          readOnly={isDeletedView}
                        />
                      </div>
                      <Link
                        href={`/issues/${bug.id}`}
                        data-issue-link=""
                        className="min-w-0 flex-1 basis-0 rounded-md scroll-my-24 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600"
                      >
                        <div className="flex flex-col gap-2">
                          <div className="min-w-0 space-y-1">
                            <p
                              className={`font-semibold text-base break-words transition-colors group-hover:text-blue-600 ${
                                isDone(bug.status) ? "text-slate-500" : "text-slate-900"
                              }`}
                            >
                              <span className="font-mono text-xs font-semibold text-slate-600 mr-2 tabular-nums">
                                {formatIssueNumber(bug.number)}
                              </span>
                              {searchText ? (
                                <Highlighted segments={highlightSegments(bug.title, searchText)} />
                              ) : (
                                bug.title
                              )}
                            </p>
                            {snippets.has(bug.id) ? (
                              <SearchSnippet snippet={snippets.get(bug.id)!} />
                            ) : null}

                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              {bug.isDeleted ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
                                  🗑️ Deleted
                                </span>
                              ) : null}
                              {bug.duplicateOf ? (
                                <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                                  Duplicate of {formatIssueNumber(bug.duplicateOf.number)}
                                </span>
                              ) : null}
                              {bug.type ? (
                                <span
                                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getIssueTypeBadgeClass(
                                    bug.type.name,
                                  )}`}
                                >
                                  {bug.type.name}
                                </span>
                              ) : null}
                              {bug.category ? (
                                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                                  {bug.category.name}
                                </span>
                              ) : null}
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700">
                                <span
                                  className={`h-2 w-2 rounded-full shrink-0 ${
                                    severityDotColors[bug.severity] ?? "bg-slate-400"
                                  }`}
                                />
                                {severityLabels[bug.severity]}
                              </span>
                              <Badge className={statusClass[bug.status]}>
                                {isDone(bug.status) ? (
                                  <svg
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    className="-ml-0.5 mr-1 h-3 w-3"
                                    aria-hidden="true"
                                  >
                                    <path
                                      fillRule="evenodd"
                                      d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                ) : null}
                                {statusLabels[bug.status]}
                              </Badge>
                            </div>

                            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500 pt-1">
                              {currentSort === "newest" ? (
                                <span>
                                  opened <LocalTime date={bug.createdAt} />
                                </span>
                              ) : (
                                <span>
                                  updated <LocalTime date={bug.updatedAt} />
                                </span>
                              )}
                              {(bug.proofLinks?.length ?? 0) > 0 ? (
                                <span>
                                  · {bug.proofLinks.length} proof link
                                  {bug.proofLinks.length === 1 ? "" : "s"}
                                </span>
                              ) : null}
                            </p>

                            {(voterSummary.likes.count > 0 ||
                              voterSummary.dislikes.count > 0) && (
                              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-500">
                                {voterSummary.likes.count > 0 && (
                                  <div className="flex items-center gap-1.5">
                                    <span>👍 {voterSummary.likes.count}</span>
                                    <VoterAvatars
                                      voters={voterSummary.likes.voters}
                                      totalCount={voterSummary.likes.count}
                                      size="sm"
                                    />
                                  </div>
                                )}
                                {voterSummary.dislikes.count > 0 && (
                                  <div className="flex items-center gap-1.5">
                                    <span>👎 {voterSummary.dislikes.count}</span>
                                    <VoterAvatars
                                      voters={voterSummary.dislikes.voters}
                                      totalCount={voterSummary.dislikes.count}
                                      size="sm"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </Link>

                      <div className="flex w-full basis-full shrink-0 items-center justify-between gap-3 self-center border-t border-slate-100 pt-2 md:basis-auto md:w-auto md:border-0 md:pt-0 md:pl-2">
                        <div className="flex items-center gap-3 text-xs text-slate-600">
                          {(bug._count?.comments ?? 0) > 0 ? (
                            <span
                              className="inline-flex items-center gap-1 text-slate-600 font-medium"
                              title={`Conversation: ${bug._count?.comments} item${bug._count?.comments === 1 ? "" : "s"}`}
                            >
                              <svg
                                className="h-4 w-4 text-slate-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                                />
                              </svg>
                              <span className="tabular-nums">{bug._count?.comments}</span>
                            </span>
                          ) : null}

                          {(bug._count?.attachments ?? 0) > 0 ? (
                            <span
                              className="inline-flex items-center gap-1 text-slate-600 font-medium"
                              title={`${bug._count?.attachments} attachments`}
                            >
                              <svg
                                className="h-4 w-4 text-slate-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                                />
                              </svg>
                              <span className="tabular-nums">{bug._count?.attachments}</span>
                            </span>
                          ) : null}

                          {bug.assignee ? (
                            <span title={`Assigned to ${bug.assignee.name}`}>
                              <Avatar
                                name={bug.assignee.name}
                                image={bug.assignee.image}
                                size="xs"
                              />
                            </span>
                          ) : null}
                        </div>

                        {isWatchingView ? (
                          <div className="flex items-center gap-1">
                            {isWatchingView && !bug.isDeleted ? (
                              <UnwatchButton
                                bugId={bug.id}
                                label={`${formatIssueNumber(bug.number)} ${bug.title}`}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <PaginationControls
                page={pagination.page}
                totalPages={pagination.totalPages}
                totalCount={totalCount}
                from={pagination.from}
                to={pagination.to}
                queryParams={{
                  ...(statusParam ? { status: statusParam } : {}),
                  ...(milestoneParam ? { [MILESTONE_PARAM]: milestoneParam } : {}),
                  ...(severityParam ? { severity: severityParam } : {}),
                  ...(mineFilter ? { mine: mineFilter } : {}),
                  ...(qParam ? { q: qParam } : {}),
                  ...(tagsParam ? { [TAGS_PARAM]: tagsParam } : {}),
                  ...(selectedPlatform ? { [PLATFORM_PARAM]: selectedPlatform } : {}),
                  ...(isDeletedView ? { deleted: "true" } : {}),
                  ...(showDuplicates ? { [DUPLICATES_PARAM]: SHOW_DUPLICATES } : {}),
                  sort: sortParam,
                }}
              />
            </>
          )}
      </div>
    </div>
  );

  if (!canDelete || isDeletedView) return page;

  return (
    <BulkSelectionProvider
      key={selectionKey}
      pageIds={bugIds}
      types={bulkTypes}
      platforms={bulkPlatforms}
      users={bulkUsers}
    >
      {page}
    </BulkSelectionProvider>
  );
}

/** What a brand-new tracker shows instead of an empty list (#292, #444). */
function FirstRunWelcome({
  isAdmin,
  hasTenant = true,
}: {
  isAdmin: boolean;
  hasTenant?: boolean;
}) {
  if (!hasTenant) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50/70 px-6 py-12 text-center">
        <h2 className="text-lg font-semibold text-slate-900">No workspace yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          You are not currently a member of any workspace. Join a workspace via an invite from your team,
          or create your own workspace to start filing issues.
        </p>
        <div className="mt-5">
          <Link
            href="/tenants"
            className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Create or join a workspace
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-slate-900">No issues yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
        This is where reported issues will appear. A good report says what you
        expected, what happened instead, and how to make it happen again.
      </p>
      <div className="mt-5">
        <Link
          href="/issues/new"
          className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          Report the first issue
        </Link>
      </div>
      {isAdmin ? (
        <p className="mx-auto mt-6 max-w-md text-sm text-slate-600">
          Before people start reporting, you may want to set up your{" "}
          <Link href="/projects" className="font-medium text-teal-700 underline">
            projects
          </Link>
          , and the{" "}
          <Link href="/admin/categories" className="font-medium text-teal-700 underline">
            platforms
          </Link>{" "}
          and{" "}
          <Link href="/admin/types" className="font-medium text-teal-700 underline">
            issue types
          </Link>{" "}
          they will choose from.
        </p>
      ) : null}
    </section>
  );
}
