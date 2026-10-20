import Link from "next/link";
import Image from "next/image";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { bugInTenant, currentTenantIdFor } from "@/lib/tenant-context";
import { viewerBugScope } from "@/lib/tenant-viewer";
import { resolveSessionUserId } from "@/lib/session-user";
import { LocalTime } from "@/components/local-time";
import { ClearDuplicateButton, MarkDuplicateButton } from "@/components/duplicate-controls";
import { currentResolution, isFinishedStatus, type StatusChangeActivity } from "@/lib/resolution-note";
import { statusLabel as resolutionStatusLabel } from "@/lib/labels";
import { formatIssueNumber } from "@/lib/issue-number";
import { buildCommentTree } from "@/lib/comments";
import {
  COMMENT_THREADS_PER_PAGE,
  earlierThreadsHref,
  loadCommentWindow,
  parseCommentTarget,
  parseThreadWindow,
  type CommentWindow,
} from "@/lib/comment-window";
import { CommentPermalinkResolver } from "@/components/comment-permalink-resolver";
import {
  bugLinkPreviewDescription,
} from "@/lib/link-preview";
import { absoluteUrl } from "@/lib/site-url";
import { SHARE_IMAGE } from "@/lib/share-image";
import {
  severityClass,
  severityLabels,
  statusClass,
  statusLabels,
} from "@/lib/labels";
import { ActivityTimeline, type ActivityEntry } from "@/components/activity-timeline";
import { IssueAgentActivity, type AgentDecision } from "@/components/issue-agent-activity";
import { IssueEscalations, type TicketEscalation } from "@/components/issue-escalations";
import { listBugEscalations } from "@/lib/agent-questions";
import { IssueBids } from "@/components/issue-bids";
import { Badge } from "@/components/ui/badge";
import { VoteButton } from "@/components/vote-button";
import { WatchButton } from "@/components/watch-button";
import { isWatchingIssue } from "@/lib/watch";
import { UpdateIssueForm } from "@/components/update-issue-form";
import { CommentThread } from "@/components/comment-thread";
import { AttachmentList, type AttachmentView } from "@/components/attachment-list";
import { ChooseRedesignButton } from "@/components/choose-redesign-button";
import { IssueApprovalBanner } from "@/components/issue-approval-banner";
import { isTenantAdminRole } from "@/lib/agents/membership";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { getActiveIssueTypesCached, getActivePlatforms } from "@/lib/lookups";
import { getIssueTypeBadgeClass } from "@/lib/issue-type-styles";
import { fetchVoterSummary } from "@/lib/voter-summaries";
import { createEmptyVoterSummary } from "@/lib/voters";
import {
  canDeleteTicket,
  deletedSummary,
  deleteSummary,
} from "@/lib/ticket-deletion";
import { currentTenantAccess } from "@/lib/tenant-access";
import { MilestoneDue } from "@/components/milestone-due";
import { dueDateValue } from "@/lib/milestones";
import { canEditTicket } from "@/lib/ticket-editing";
import { DeleteIssueButton } from "@/components/delete-issue-button";
import { RestoreIssueButton } from "@/components/restore-issue-button";
import { canAssignTicket } from "@/lib/ticket-assignment";
import { SelfAssignButton } from "@/components/self-assign-button";
import { EditableIssueDescription } from "@/components/editable-issue-description";
import { EditableProofLinks } from "@/components/editable-proof-links";
import { withCurrentOption } from "@/lib/triage-options";
import { issueTenantHintFor } from "@/lib/issue-tenant-hint";
import { IssueTenantSwitch } from "@/components/issue-tenant-hint";

type BugPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const NO_COMMENTS: CommentWindow = {
  comments: [],
  shownThreads: 0,
  hiddenThreads: 0,
  visibleCount: 0,
};

/** How much of the activity log a single page render is allowed to load. */
const ACTIVITY_PAGE_SIZE = 50;

async function loadOptional<T>(label: string, fallback: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[issue] ${label} failed`, error);
    return fallback;
  }
}

function issueLoadError(detail: string) {
  return (
    <div className="rounded-xl border border-red-200 bg-white px-6 py-10">
      <h1 className="text-xl font-semibold text-slate-900">This issue could not be loaded</h1>
      <p className="mt-2 text-sm text-slate-600">
        The issue query failed. The message below is the database error.
      </p>
      <pre className="mt-4 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-800">
        {detail}
      </pre>
    </div>
  );
}

export async function generateMetadata({
  params,
}: BugPageProps): Promise<Metadata> {
  const { id } = await params;
  const bug = await prisma.bug.findUnique({
    where: { id, ...(await viewerBugScope()) },
    select: {
      number: true,
      title: true,
      status: true,
      updatedAt: true,
      isDeleted: true,
    },
  });

  if (!bug || bug.isDeleted) {
    return {
      title: "Issue not found",
      description: "This issue could not be found.",
      robots: { index: false, follow: false },
    };
  }

  // Title and status only: these tags are served to anyone with a preview-bot
  // User-Agent, signed in or not (#117).
  const description = bugLinkPreviewDescription({ status: bug.status });
  const canonical = absoluteUrl(`/issues/${id}`);
  const image = absoluteUrl(SHARE_IMAGE.url);
  // The reference goes in the tab title too: with several issues open, the
  // number is what tells two similar titles apart.
  const title = `${formatIssueNumber(bug.number)} ${bug.title}`;

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "article",
      siteName: "Ziki Issues",
      modifiedTime: bug.updatedAt.toISOString(),
      images: [{ ...SHARE_IMAGE, url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    other: {
      "bug:status": statusLabels[bug.status],
    },
  };
}

/**
 * Renders the issue detail page including discussion threads, activity
 * timeline, attachment viewer, and triage controls.
 *
 * Performance optimization (#349): Gating the full user directory query behind
 * `canTriage` ensures non-triage viewers do not run unnecessary database queries.
 *
 * @param props.params - Route parameters containing the issue `id`.
 * @param props.searchParams - Optional query params for thread windowing or permalinks.
 */
export default async function BugDetailPage({ params, searchParams }: BugPageProps) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const resolved = await resolveSessionUserId();
  const userId = "userId" in resolved ? resolved.userId : undefined;

  // Unauthenticated link-preview bots get the title and status only (#117).
  // They're recognised by User-Agent, which anyone can fake, so nothing more
  // sensitive (reporter, severity, description) may appear here.
  if (!userId) {
    const bug = await prisma.bug.findUnique({
      where: { id },
      select: {
        title: true,
        status: true,
        isDeleted: true,
      },
    });
    if (!bug || bug.isDeleted) notFound();

    return (
      <div className="mx-auto max-w-2xl space-y-4 py-10">
        <p className="text-sm text-slate-500">Ziki Issues</p>
        <h1 className="text-2xl font-semibold text-slate-900">{bug.title}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge className={statusClass[bug.status]}>
            {statusLabels[bug.status]}
          </Badge>
        </div>
        <Link
          href={`/login?callbackUrl=${encodeURIComponent(`/issues/${id}`)}`}
          className="inline-flex text-sm font-medium text-teal-700 hover:underline"
        >
          Sign in to view full details
        </Link>
      </div>
    );
  }

  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  const canTriage = access.admin;
  const canDelete = canDeleteTicket(user.role, access.membershipRole);
  // #289: open milestones for the triage panel (admins only). Started here,
  // alongside the issue query, and awaited where the form needs them.
  const milestoneOptionsPromise: Promise<{ id: string; title: string; isClosed: boolean }[]> = canTriage
    ? loadOptional("milestones", [], () =>
        prisma.milestone.findMany({
          where: { isClosed: false },
          select: { id: true, title: true, isClosed: true },
          orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { title: "asc" }],
        }),
      )
    : Promise.resolve([]);

  // The list page already proved the issue row itself can be read. Comments,
  // the activity log, watches and attachments are newer tables. One of them
  // missing used to reject this whole Promise and blank the page.
  let loadedBug = await prisma.bug
    .findUnique({
      where: { id, ...bugInTenant(await currentTenantIdFor(userId)) },
      include: {
        type: { select: { id: true, name: true, isActive: true } },
        reporter: { select: { name: true, email: true, role: true, image: true } },
        createdByAgent: { select: { id: true, name: true } },
        milestone: { select: { id: true, title: true, dueDate: true, isClosed: true } },
        assignee: { select: { id: true, name: true, role: true, image: true } },
        category: { select: { id: true, name: true, isActive: true } },
        votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
        // #285: both sides of a duplicate link.
        duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true } },
        duplicates: {
          where: { isDeleted: false },
          select: { id: true, number: true, title: true, status: true },
          orderBy: { number: "asc" },
          take: 20,
        },
        _count: { select: { duplicates: { where: { isDeleted: false } } } },
      },
    })
    .then((bug) => ({ bug }))
    .catch((error: unknown) => {
      console.error("[issue] detail query failed", error);
      const detail = error instanceof Error ? error.message : "Could not load issue";
      return { detail };
    });

  // If the query failed because Bug.milestoneId or Milestone does not exist in
  // the current database, retry without the milestone relation so the page
  // continues to load cleanly (#289).
  if ("detail" in loadedBug && /milestoneId|Milestone/i.test(loadedBug.detail)) {
    loadedBug = await prisma.bug
      .findUnique({
        where: { id, ...bugInTenant(await currentTenantIdFor(userId)) },
        include: {
          type: { select: { id: true, name: true, isActive: true } },
          reporter: { select: { name: true, email: true, role: true, image: true } },
          createdByAgent: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true, role: true, image: true } },
          category: { select: { id: true, name: true, isActive: true } },
          votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
          duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true } },
          duplicates: {
            where: { isDeleted: false },
            select: { id: true, number: true, title: true, status: true },
            orderBy: { number: "asc" },
            take: 20,
          },
          _count: { select: { duplicates: { where: { isDeleted: false } } } },
        },
      })
      .then((bug) => ({
        bug: bug
          ? {
              ...bug,
              milestoneId: null,
              milestone: null,
            }
          : null,
      }))
      .catch((error: unknown) => {
        console.error("[issue] fallback detail query without milestone failed", error);
        const detail = error instanceof Error ? error.message : "Could not load issue";
        return { detail };
      });
  }

  if ("detail" in loadedBug) {
    return issueLoadError(loadedBug.detail);
  }
  const bug = loadedBug.bug;

  if (!bug) {
    // A link into another of the viewer's tenants should not dead-end (#519):
    // name the tenant and offer the switch. Non-members still get the 404.
    const hint = await issueTenantHintFor(prisma, {
      userId,
      activeTenantId: await currentTenantIdFor(userId),
      issueId: id,
    });
    if (!hint) notFound();
    return <IssueTenantSwitch issueId={id} tenant={hint} />;
  }

  if (bug.isDeleted && !canDelete) {
    notFound();
  }

  const tenantId = await currentTenantIdFor(userId);
  // These tables arrived after the issue row. A missing one must not blank the page.
  const [redesignProposals, membership] = tenantId ? await Promise.all([
    loadOptional("redesigns", [], () =>
      prisma.redesignProposal.findMany({
        where: { tenantId, bugId: bug.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, body: true, previewUrl: true, status: true,
          authorAgent: { select: { name: true } }, attachments: { select: { id: true, filename: true, contentType: true } } },
      }),
    ),
    loadOptional("membership", null, () =>
      prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { role: true } }),
    ),
  ]) : [[], null] as const;
  const canChooseRedesign = isTenantAdminRole(membership?.role, user.role);
  const openBids = await loadOptional("bids", [], () =>
    prisma.issueBid.findMany({
      where: { bugId: bug.id, withdrawnAt: null, awardedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        note: true,
        beneficiaryUserId: true,
        agent: { select: { name: true } },
        beneficiary: { select: { name: true } },
      },
    }),
  );
  const canAwardBid = bug.status === "open" && !bug.isDeleted && (bug.reporterId === user.id || canChooseRedesign);

  const [users, categories, types, voterSummary, activities, activityCount, watchRow, comments, latestStatusChange, attachments, lastRevision, agentDecisions, escalations, volunteerCount, pendingApproval] =
    await Promise.all([
      canTriage
        ? loadOptional("users", [], () =>
            prisma.user.findMany({
              orderBy: { name: "asc" },
              select: { id: true, name: true, role: true, image: true },
            }),
          )
        : Promise.resolve([]),
      loadOptional("platforms", [], () => getActivePlatforms(bug.tenantId)),
      canTriage ? loadOptional("types", [], () => getActiveIssueTypesCached()) : Promise.resolve([]),
      loadOptional("votes", createEmptyVoterSummary(), () => fetchVoterSummary(id)),
      loadOptional("activity", [] as ActivityEntry[], () =>
        prisma.bugActivity.findMany({
          where: { bugId: id },
          include: { actor: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: ACTIVITY_PAGE_SIZE,
        }),
      ),
      loadOptional("activity count", 0, () => prisma.bugActivity.count({ where: { bugId: id } })),
      loadOptional<{ userId: string; watching: boolean } | null>("watch", null, () =>
        prisma.issueWatch.findUnique({
          where: { userId_bugId: { userId: user.id, bugId: id } },
          select: { userId: true, watching: true },
        }),
      ),
      // The newest threads only (#280); a permalink widens the window to
      // reach its comment.
      loadOptional("comments", NO_COMMENTS, () =>
        loadCommentWindow(prisma, id, {
          threads: parseThreadWindow(query.threads),
          target: parseCommentTarget(query.comment),
        }),
      ),
      // #316: the status change that put the issue in its current state,
      // read on its own so it is found even when the timeline is trimmed.
      isFinishedStatus(bug.status)
        ? loadOptional<StatusChangeActivity | null>("resolution note", null, () =>
            prisma.bugActivity.findFirst({
              where: { bugId: id, type: "status_changed" },
              orderBy: { createdAt: "desc" },
              select: { createdAt: true, metadata: true, actor: { select: { name: true } } },
            }),
          )
        : Promise.resolve(null),
      // Files on the issue and on its comments (#215); never the file contents here.
      loadOptional("attachments", [], () =>
        prisma.attachment.findMany({
          where: { bugId: id },
          select: { id: true, filename: true, contentType: true, size: true, commentId: true },
          orderBy: { createdAt: "asc" },
        }),
      ),
      // #303: only whether there is history, and when it last changed.
      loadOptional<{ editedAt: Date } | null>("revisions", null, () =>
        prisma.bugRevision.findFirst({
          where: { bugId: id },
          orderBy: { editedAt: "desc" },
          select: { editedAt: true },
        }),
      ),
      // #448: what agents decided on this issue — confirmations, the claim,
      // test verdicts, and whether an agent accepted the fix. Sentences only;
      // the raw audit payloads live on the audit page (#447).
      loadOptional<AgentDecision[]>("agent decisions", [], async () => {
        const [validations, claims, verdicts, accepted] = await Promise.all([
          prisma.issueValidation.findMany({
            where: { bugId: id, kind: "real", verdict: "accept" },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              createdAt: true,
              severity: true,
              agent: { select: { name: true } },
              onBehalfOf: { select: { name: true } },
            },
          }),
          prisma.issueClaim.findMany({
            where: { bugId: id, status: "active", releasedAt: null },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              createdAt: true,
              deliverBy: true,
              extendedAt: true,
              agent: { select: { name: true } },
              beneficiary: { select: { name: true } },
            },
          }),
          prisma.testVerdict.findMany({
            where: { bugId: id },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              createdAt: true,
              goodToMerge: true,
              agent: { select: { name: true } },
              onBehalfOf: { select: { name: true } },
            },
          }),
          prisma.agentAuditEvent.findMany({
            where: { bugId: id, action: "issue.accepted" },
            orderBy: { createdAt: "asc" },
            select: { id: true, createdAt: true, agent: { select: { name: true } } },
          }),
        ]);
        return [
          ...validations.map<AgentDecision>((v) => ({
            id: `validation-${v.id}`,
            at: v.createdAt,
            kind: "confirmed",
            agentName: v.agent.name,
            personName: v.onBehalfOf.name,
            severity: v.severity,
          })),
          ...claims.map<AgentDecision>((c) => ({
            id: `claim-${c.id}`,
            at: c.createdAt,
            kind: "claimed",
            agentName: c.agent.name,
            personName: c.beneficiary.name,
            deliverBy: bug.pullRequestUrl ? null : c.deliverBy,
            extendedAt: c.extendedAt,
          })),
          ...verdicts.map<AgentDecision>((v) => ({
            id: `verdict-${v.id}`,
            at: v.createdAt,
            kind: "verdict",
            agentName: v.agent.name,
            personName: v.onBehalfOf.name,
            goodToMerge: v.goodToMerge,
          })),
          ...accepted.map<AgentDecision>((e) => ({
            id: `accepted-${e.id}`,
            at: e.createdAt,
            kind: "accepted",
            agentName: e.agent.name,
          })),
        ];
      }),
      loadOptional<TicketEscalation[]>("escalations", [], () =>
        tenantId ? listBugEscalations(id, tenantId) : Promise.resolve([]),
      ),
      loadOptional<number>("volunteers", 0, () =>
        prisma.issueInterest.count({
          where: { bugId: id, withdrawnAt: null },
        }),
      ),
      loadOptional("pendingApproval", null, () =>
        (typeof (prisma as { issueApproval?: unknown }).issueApproval !== "undefined"
          ? prisma.issueApproval.findFirst({
              where: { bugId: id, status: "pending" },
              include: { rule: { include: { issueType: { select: { name: true } } } } },
              orderBy: { createdAt: "desc" },
            })
          : Promise.resolve(null)),
      ),
    ]);
  const issueAttachments: AttachmentView[] = attachments.filter((a) => !a.commentId);
  const attachmentsByComment: Record<string, AttachmentView[]> = {};
  for (const a of attachments) {
    if (a.commentId) (attachmentsByComment[a.commentId] ??= []).push(a);
  }

  const milestoneOptions = await milestoneOptionsPromise;
  const isAssignee = !!userId && bug.assigneeId === userId;
  const canUpdateStatus = canTriage || isAssignee;
  const canEdit =
    canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      reporterId: bug.reporterId,
    }) && !bug.isDeleted;
  const canSelfAssign =
    !bug.isDeleted &&
    canAssignTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: bug.assigneeId,
      targetAssigneeId: isAssignee ? null : userId,
      voteCount: bug.voteCount,
    });
  const userVote =
    Array.isArray(bug.votes) && bug.votes.length > 0
      ? (bug.votes[0].value ?? 1)
      : 0;
  const commentTree = buildCommentTree(comments.comments);
  const pageQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") pageQuery.set(key, value);
  }
  const proofLinks = bug.proofLinks ?? [];

  const resolution = currentResolution(bug.status, latestStatusChange);

  const extraBadgeCount =
    (bug.isBoosted && !bug.isDeleted ? 1 : 0) +
    (bug.type ? 1 : 0) +
    (bug.category ? 1 : 0) +
    1 +
    (volunteerCount > 0 ? 1 : 0);

  const headerActions = (
    <>
      {canSelfAssign ? (
        <SelfAssignButton
          bugId={bug.id}
          isAssignedToMe={isAssignee}
          size="sm"
        />
      ) : null}
      {!bug.isDeleted ? (
        <WatchButton
          bugId={bug.id}
          watching={isWatchingIssue(user.id, [bug.reporterId, bug.assigneeId], watchRow)}
        />
      ) : null}
      {canTriage && !bug.isDeleted && !bug.duplicateOf ? (
        <MarkDuplicateButton bugId={bug.id} />
      ) : null}
      {!bug.isDeleted && userId && (bug.reporterId === userId || bug.assigneeId === userId) ? (
        <Link
          href={`/points/disputes/new?bug=${bug.number}`}
          className="text-xs font-medium text-teal-700 hover:text-teal-800 hover:underline"
          title="Say your points award for this issue is missing or wrong"
        >
          Dispute award
        </Link>
      ) : null}
    </>
  );

  // What a delete keeps, shown the same way in every delete/restore message (#692).
  const deletionCounts = {
    comments: comments.visibleCount,
    votes: voterSummary.likes.count + voterSummary.dislikes.count,
  };

  return (
    <div className="space-y-6">
      {bug.isDeleted ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="text-xl">🗑️</span>
              <div>
                <h3 className="text-sm font-semibold text-red-900">
                  This issue was deleted
                </h3>
                <p className="text-xs text-red-700">
                  {deletedSummary(deletionCounts)}
                </p>
              </div>
            </div>
            <RestoreIssueButton
              bugId={bug.id}
              bugTitle={bug.title}
              counts={deletionCounts}
              size="sm"
            />
          </div>
        </div>
      ) : null}

      {bug.duplicateOf ? (
        <section
          aria-label="Duplicate"
          className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
        >
          <p className="text-sm text-amber-950">
            <span className="font-semibold">This issue is a duplicate of </span>
            {bug.duplicateOf.isDeleted && !canDelete ? (
              <span>{formatIssueNumber(bug.duplicateOf.number)} (since deleted)</span>
            ) : (
              <Link href={`/issues/${bug.duplicateOf.id}`} className="font-semibold text-teal-800 underline-offset-2 hover:underline">
                {formatIssueNumber(bug.duplicateOf.number)} {bug.duplicateOf.title}
              </Link>
            )}{" "}
            <span className="text-amber-900">({statusLabels[bug.duplicateOf.status]})</span>.{" "}
            Follow and vote there instead. It&apos;s hidden from the issues list.
          </p>
          {canTriage ? (
            <div className="flex shrink-0 items-center gap-1 print:hidden">
              <MarkDuplicateButton bugId={bug.id} label="Change" />
              <ClearDuplicateButton bugId={bug.id} />
            </div>
          ) : null}
        </section>
      ) : null}

      {bug._count.duplicates > 0 ? (
        <section aria-label="Duplicates of this issue" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-slate-900">
            {bug._count.duplicates} duplicate{bug._count.duplicates === 1 ? "" : "s"} of this issue
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {bug.duplicates.map((d) => (
              <li key={d.id}>
                <Link href={`/issues/${d.id}`} className="text-teal-800 hover:underline">
                  <span className="text-slate-500 tabular-nums">{formatIssueNumber(d.number)}</span> {d.title}
                </Link>{" "}
                <span className="text-xs text-slate-500">· {statusLabels[d.status]}</span>
              </li>
            ))}
          </ul>
          {bug._count.duplicates > bug.duplicates.length ? (
            <p className="mt-1 text-xs text-slate-500">
              And {bug._count.duplicates - bug.duplicates.length} more.
            </p>
          ) : null}
        </section>
      ) : null}

      {pendingApproval ? (
        <IssueApprovalBanner
          approval={pendingApproval}
          canDecide={canChooseRedesign}
        />
      ) : null}

      {redesignProposals.length ? (
        <section aria-label="Redesign proposals" className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 sm:p-5">
          <h2 className="text-lg font-semibold text-slate-900">Compare redesign proposals</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {redesignProposals.map((proposal) => (
              <article key={proposal.id} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold">{proposal.title}</h3>
                  <span className="shrink-0 text-xs capitalize text-slate-600">{proposal.status}</span>
                </div>
                <p className="text-xs text-slate-600">By {proposal.authorAgent.name}</p>
                <p className="whitespace-pre-wrap text-sm text-slate-800">{proposal.body}</p>
                {proposal.previewUrl ? <a className="text-sm text-indigo-700 underline" href={proposal.previewUrl} target="_blank" rel="noreferrer">Open live preview</a> : null}
                {proposal.attachments.length ? <div className="grid grid-cols-2 gap-2">
                  {proposal.attachments.map((file) => <a key={file.id} href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" className="space-y-1 text-sm text-indigo-700 underline">
                    <Image src={`/api/attachments/${file.id}`} alt={file.filename} width={480} height={320} unoptimized className="h-auto max-h-56 w-full rounded border border-slate-200 object-contain" />
                    <span className="block">{file.filename}</span>
                  </a>)}
                </div> : null}
                {canChooseRedesign && proposal.status === "proposed" ? <ChooseRedesignButton id={proposal.id} /> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {resolution ? (
        <section
          aria-label="Resolution note"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5"
        >
          <h2 className="text-sm font-semibold text-emerald-900">
            {resolutionStatusLabel[resolution.status]} by {resolution.by}
            <span className="ml-2 text-xs font-normal text-emerald-800">
              <LocalTime date={resolution.at} />
            </span>
          </h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-emerald-950">
            {resolution.note}
          </p>
        </section>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <Link href="/issues" className="text-sm text-teal-700 hover:underline print:hidden">
            ← Back to issues
          </Link>
          <div className="mt-3 space-y-3">
            <div className="space-y-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 break-words">
                <span className="font-normal text-slate-500 tabular-nums">
                  {formatIssueNumber(bug.number)}
                </span>{" "}
                {bug.title}
              </h1>

              {/* On mobile (<sm): compact horizontal scroll action row pinned directly under title (#698) */}
              <div
                data-testid="mobile-actions-row"
                className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden sm:hidden print:hidden"
              >
                {headerActions}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {bug.isDeleted ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-900 shadow-2xs">
                    🗑️ Deleted
                  </span>
                ) : null}
                <Badge className={statusClass[bug.status]}>
                  {statusLabels[bug.status]}
                </Badge>
                <Badge className={severityClass[bug.severity]}>
                  {severityLabels[bug.severity]}
                </Badge>
                {extraBadgeCount > 0 ? (
                  <details className="group sm:contents">
                    <summary
                      aria-label={`${extraBadgeCount} more details`}
                      className="cursor-pointer list-none select-none inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 sm:hidden"
                    >
                      +{extraBadgeCount}
                    </summary>
                    <span className="contents">
                      {bug.isBoosted && !bug.isDeleted ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 shadow-2xs">
                          ⚡ Boosted
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
                        <Badge className="border border-teal-200 bg-teal-50 text-teal-950">
                          {bug.category.name}
                        </Badge>
                      ) : null}
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                        {bug.voteCount} score ({voterSummary.likes.count} like{voterSummary.likes.count === 1 ? "" : "s"}, {voterSummary.dislikes.count} dislike{voterSummary.dislikes.count === 1 ? "" : "s"})
                      </span>
                      {volunteerCount > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 border border-indigo-200">
                          {volunteerCount} {volunteerCount === 1 ? "agent volunteered" : "agents volunteered"}
                        </span>
                      ) : null}
                    </span>
                  </details>
                ) : null}
              </div>
            </div>

            {/* Reactions and larger avatars sitting under the title */}
            <div className="pt-1">
              <VoteButton
                bugId={bug.id}
                voteCount={bug.voteCount}
                userVote={userVote}
                likeCount={voterSummary.likes.count}
                dislikeCount={voterSummary.dislikes.count}
                likeVoters={voterSummary.likes.voters}
                dislikeVoters={voterSummary.dislikes.voters}
                size="md"
                showAvatars
                readOnly={bug.isDeleted}
              />
            </div>
          </div>
        </div>

        <div className="hidden sm:block">
          <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:pt-6 print:hidden">
            {headerActions}
          </div>
        </div>
      </div>

      <EditableIssueDescription
        bugId={bug.id}
        initialTitle={bug.title}
        initialDescription={bug.description}
        canEdit={canEdit}
        users={users}
        lastEditedAt={lastRevision?.editedAt ?? null}
        historyHref={`/issues/${bug.id}/history`}
      >
        <dl className="mt-6 grid grid-cols-1 gap-3 text-sm text-slate-600 sm:grid-cols-2">
          {bug.type ? (
            <div>
              <dt className="font-medium text-slate-500">Type</dt>
              <dd>
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getIssueTypeBadgeClass(
                    bug.type.name,
                  )}`}
                >
                  {bug.type.name}
                </span>
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium text-slate-500">Reporter</dt>
            <dd>
              <UserNameWithBadges
                name={bug.reporter.name}
                role={bug.reporter.role}
                image={bug.reporter.image}
                avatar="sm"
                userId={bug.reporterId}
                agentName={bug.createdByAgent?.name}
                showAuthor
              />
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Assignee</dt>
            <dd className="flex items-center gap-2">
              {bug.assignee ? (
                <UserNameWithBadges
                  name={bug.assignee.name}
                  role={bug.assignee.role}
                  image={bug.assignee.image}
                  avatar="sm"
                  userId={bug.assigneeId}
                />
              ) : (
                <span className="text-slate-500">Unassigned</span>
              )}
              {canSelfAssign ? (
                <SelfAssignButton
                  bugId={bug.id}
                  isAssignedToMe={isAssignee}
                  variant="ghost"
                  size="xs"
                />
              ) : null}
            </dd>
          </div>
          {bug.category ? (
            <div>
              <dt className="font-medium text-slate-500">Platform</dt>
              <dd>{bug.category.name}</dd>
            </div>
          ) : null}
          {bug.milestone ? (
            <div>
              <dt className="font-medium text-slate-500">Milestone</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Link href={`/issues?milestone=${bug.milestone.id}`} className="text-teal-700 hover:underline">
                  {bug.milestone.title}
                </Link>
                <MilestoneDue due={dueDateValue(bug.milestone.dueDate) || null} isClosed={bug.milestone.isClosed} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium text-slate-500">Created</dt>
            <dd><LocalTime date={bug.createdAt} /></dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Updated</dt>
            <dd><LocalTime date={bug.updatedAt} /></dd>
          </div>
        </dl>
      </EditableIssueDescription>

      {issueAttachments.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Attachments
          </h2>
          <AttachmentList attachments={issueAttachments} />
        </section>
      ) : null}

      <EditableProofLinks bugId={bug.id} initialLinks={proofLinks} canEdit={canEdit} />

      {canUpdateStatus && !bug.isDeleted ? (
        <UpdateIssueForm
          bugId={bug.id}
          status={bug.status}
          severity={bug.severity}
          typeId={bug.typeId}
          assigneeId={bug.assigneeId}
          categoryId={bug.categoryId}
          users={users}
          categories={withCurrentOption(categories, bug.category)}
          types={withCurrentOption(types, bug.type)}
          milestoneId={bug.milestoneId}
          milestones={
            bug.milestone && !milestoneOptions.some((m) => m.id === bug.milestone?.id)
              ? [...milestoneOptions, { id: bug.milestone.id, title: bug.milestone.title, isClosed: bug.milestone.isClosed }]
              : milestoneOptions
          }
          canEditTriage={canTriage}
        />
      ) : null}

      <ActivityTimeline
        activities={[...activities].reverse()}
        totalCount={activityCount}
      />

      <IssueBids
        bids={openBids.map((bid) => ({
          id: bid.id,
          agentName: bid.agent.name,
          personName: bid.beneficiary.name ?? "A member",
          note: bid.note,
        }))}
        canAward={canAwardBid}
      />

      <IssueEscalations escalations={escalations} />

      <IssueAgentActivity decisions={agentDecisions} />

      <section
        id="conversation"
        className="scroll-mt-24 rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
      >
        <span id="comments" className="sr-only" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Conversation ({comments.visibleCount})
        </h2>
        {comments.hiddenThreads > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 print:hidden">
            <span>
              {comments.hiddenThreads} earlier{" "}
              {comments.hiddenThreads === 1 ? "thread" : "threads"} not shown.
            </span>
            <Link
              href={earlierThreadsHref(pageQuery, comments.shownThreads)}
              scroll={false}
              className="font-medium text-teal-700 hover:underline"
            >
              Show {Math.min(comments.hiddenThreads, COMMENT_THREADS_PER_PAGE)} earlier
            </Link>
            {comments.hiddenThreads > COMMENT_THREADS_PER_PAGE ? (
              <Link
                href={earlierThreadsHref(pageQuery, comments.shownThreads, true)}
                scroll={false}
                className="font-medium text-teal-700 hover:underline"
              >
                Show all
              </Link>
            ) : null}
          </div>
        ) : null}
        <Suspense fallback={null}>
          <CommentPermalinkResolver />
        </Suspense>
        <CommentThread
          bugId={bug.id}
          issueUrl={absoluteUrl(`/issues/${bug.id}`)}
          reporterId={bug.reporterId}
          comments={commentTree}
          attachmentsByComment={attachmentsByComment}
          users={users}
          currentUserId={user.id}
          currentUserRole={user.role}
          tenantAdmin={access.admin}
          readOnly={bug.isDeleted}
        />
      </section>

      {canDelete && !bug.isDeleted ? (
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-4 sm:p-6 print:hidden">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">
                Danger zone
              </h2>
              <p className="text-sm text-slate-600">
                Delete this issue. {deleteSummary(deletionCounts)}
              </p>
            </div>
            <DeleteIssueButton
              bugId={bug.id}
              bugTitle={bug.title}
              counts={deletionCounts}
              variant="danger"
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
