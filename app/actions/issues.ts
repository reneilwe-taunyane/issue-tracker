"use server";

import { revalidatePath } from "next/cache";
import { fieldError, fromZodError } from "@/lib/form-errors";
import { redirect } from "next/navigation";
import {
  activityCreateData,
  assigneeChangedSummary,
  boostedSummary,
  categoryChangedSummary,
  commentedSummary,
  commentPreview,
  createdSummary,
  deletedSummary,
  restoredSummary,
  severityChangedSummary,
  statusChangedSummary,
  typeChangedSummary,
  unboostedSummary,
  type ActivityMetadata,
} from "@/lib/activity-log";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import {
  resolveSessionUserId,
  SESSION_EXPIRED_MESSAGE,
} from "@/lib/session-user";
import { MAX_COMMENT_DEPTH, commentDepth } from "@/lib/comments";
import {
  extractMentionedUserIds,
  newlyMentionedUserIds,
  normalizeMentions,
} from "@/lib/mentions";
import {
  commentSchema,
  createBugSchema,
  editBugContentSchema,
  editProofLinksSchema,
  updateBugSchema,
} from "@/lib/validations/issue";
import {
  calculateVoteChange,
  isValidVoteDirection,
  reconcileVoteCount,
} from "@/lib/voting";
import {
  canDeleteTicket,
  canRestoreTicket,
  TICKET_DELETION_ERRORS,
} from "@/lib/ticket-deletion";
import {
  canBoostTicket,
  shouldUnboostOnStatusChange,
  TICKET_BOOST_ERRORS,
} from "@/lib/ticket-boosting";
import { canAssignTicket, TICKET_ASSIGN_ERRORS } from "@/lib/ticket-assignment";
import { canChangeTicketStatus, TICKET_TRIAGE_ERRORS } from "@/lib/ticket-triage";
import { publish } from "@/lib/agent-api/events";
import {
  canEditTicket,
  formatEditSummary,
  formatProofLinkSummary,
  getChangedEditFields,
  getProofLinkChanges,
  TICKET_EDIT_ERRORS,
} from "@/lib/ticket-editing";
import { Prisma, type ActivityType } from "@prisma/client";
import { isBugNumberConflict, repairBugNumberSequence } from "@/lib/bug-number";
import { notifyLater } from "@/lib/notify";
import { ensureWatching } from "@/lib/watch";
import { parseResolutionNote } from "@/lib/resolution-note";
import { isUntouchedTemplate, UNFILLED_TEMPLATE_MESSAGE } from "@/lib/issue-templates";
import type { NotificationEvent } from "@/lib/notifications";
import { getForeignKeyErrorMessage } from "@/lib/foreign-key-errors";
import { parseAttachmentIds } from "@/lib/attachments";
import { attachmentIdsInMarkdown, linkAttachments } from "@/lib/attachment-link";
import {
  bugInTenant,
  currentTenantIdFor,
  defaultProjectIdFor,
  NO_TENANT_MESSAGE,
} from "@/lib/tenant-context";
import { currentTenantAccess } from "@/lib/tenant-access";
import { awardSolver } from "@/lib/points/award";
import { isConfirmed } from "@/lib/agent-api/validation";
import { correct } from "@/lib/points/correct";
import { pointSourceKey } from "@/lib/points/rules";
import {
  checkRateLimit,
  consumeRateLimit,
  ACTION_RATE_LIMITS,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit";
import { issueChangePayload, publishWebEvent } from "@/lib/agent-api/web-events";

export type ActionResult = {
  error?: string;
  ok?: boolean;
  /** Which field failed, when there is one (#309). */
  field?: string;
  fieldErrors?: Record<string, string>;
};

/**
 * Resolves `@[Name](userId)` tags against real accounts: known ids are
 * rewritten to the current name, unknown ids degrade to plain `@Name`.
 */
async function normalizeMentionTags(text: string): Promise<string> {
  const mentionedIds = extractMentionedUserIds(text);
  if (mentionedIds.length === 0) return text;

  const validUsers = await prisma.user.findMany({
    where: { id: { in: mentionedIds } },
    select: { id: true, name: true },
  });
  const userMap = new Map(validUsers.map((user) => [user.id, user.name]));
  return normalizeMentions(text, userMap);
}

function foreignKeyError(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    return getForeignKeyErrorMessage(error.meta as Record<string, unknown> | undefined);
  }
  return null;
}

/** Reads the type, including when the template column has not been migrated yet. */
async function issueTypeForCreate(typeId: string) {
  try {
    return await prisma.issueType.findUnique({
      where: { id: typeId },
      select: { id: true, isActive: true, template: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const missingTemplate =
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2022" &&
        "meta" in error &&
        String((error as { meta?: { column?: unknown } }).meta?.column ?? "").includes("template")) ||
      /column [`'"]?(?:[\w."]+\.)*template[`'"]?/i.test(message);
    if (!missingTemplate) throw error;
    const row = await prisma.issueType.findUnique({
      where: { id: typeId },
      select: { id: true, isActive: true },
    });
    return row ? { ...row, template: null } : null;
  }
}

/** Redirects to login when the JWT is missing or no longer maps to a User row. */
async function requireUserId() {
  const resolved = await resolveSessionUserId();
  if ("error" in resolved) {
    redirect("/login");
  }
  return resolved.userId;
}

/** Creates a bug as the signed-in user; only admins may set severity/assignee. */
export async function createBugAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;
  const access = await currentTenantAccess(userId, user.role);
  const admin = access.admin;

  const limit = await consumeRateLimit(
    `create-bug:${userId}`,
    ACTION_RATE_LIMITS.createBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const rawAssignee = formData.get("assigneeId");
  const targetAssigneeId =
    rawAssignee === "" || rawAssignee === "unassigned" || rawAssignee === null || rawAssignee === undefined
      ? null
      : typeof rawAssignee === "string"
        ? rawAssignee.trim()
        : null;

  if (targetAssigneeId) {
    if (
      !canAssignTicket({
        actorId: userId,
        actorRole: user.role,
        membershipRole: access.membershipRole,
        currentAssigneeId: null,
        targetAssigneeId,
      })
    ) {
      return { error: TICKET_ASSIGN_ERRORS.unauthorized };
    }
  }

  // Auto-generate title from description if omitted or blank (for simplified report intake)
  const rawTitle = formData.get("title");
  const rawDesc = formData.get("description");
  let titleStr = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const isReport = formData.get("isReport") === "true";

  if (!titleStr && typeof rawDesc === "string" && rawDesc.trim().length >= 3) {
    const firstLine = rawDesc.trim().split(/\r?\n/)[0]?.trim() || "";
    titleStr = firstLine.slice(0, 80);
    if (titleStr.length < 3) {
      titleStr = rawDesc.trim().slice(0, 80);
    }
  }

  // Non-admins cannot set severity at creation; assignee validated above.
  const parsed = createBugSchema.safeParse({
    title: titleStr,
    description: formData.get("description"),
    severity: admin ? formData.get("severity") || "medium" : "medium",
    typeId: formData.get("typeId") || "",
    assigneeId: targetAssigneeId || "",
    categoryId: formData.get("categoryId") || "",
    proofLinks: formData.get("proofLinks") || "",
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  const assigneeId =
    parsed.data.assigneeId && parsed.data.assigneeId.length > 0
      ? parsed.data.assigneeId
      : null;

  const typeId =
    parsed.data.typeId && parsed.data.typeId.length > 0
      ? parsed.data.typeId
      : null;

  if (assigneeId) {
    const assignee = await prisma.user.findUnique({
      where: { id: assigneeId },
      select: { id: true },
    });
    if (!assignee) {
      return fieldError("assigneeId", "Assignee not found");
    }
  }

  if (typeId) {
    const issueType = await issueTypeForCreate(typeId);
    if (!issueType || !issueType.isActive) {
      return fieldError("typeId", "That type no longer exists. Please pick another.");
    }
    // #307: headings alone pass the length check but say nothing.
    if (isUntouchedTemplate(parsed.data.description, issueType.template)) {
      return fieldError("description", UNFILLED_TEMPLATE_MESSAGE);
    }
  }

  const description = await normalizeMentionTags(parsed.data.description);

  const categoryId =
    parsed.data.categoryId && parsed.data.categoryId.length > 0
      ? parsed.data.categoryId
      : null;

  // #425: the issue goes into the reporter's tenant. No membership, no issue.
  const tenantId = await currentTenantIdFor(userId);
  const projectId = tenantId ? await defaultProjectIdFor(prisma, tenantId) : null;
  if (!tenantId || !projectId) {
    return { error: NO_TENANT_MESSAGE };
  }

  if (categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!category) {
      return fieldError("categoryId", "Platform not found or inactive");
    }
  }

  // Always open at creation — createBugSchema rejects client status.
  const issueData = {
    tenantId,
    projectId,
    beneficiaryUserId: userId,
    title: parsed.data.title,
    description,
    severity: admin ? parsed.data.severity : "medium",
    status: "open" as const,
    voteCount: 0,
    typeId,
    proofLinks: parsed.data.proofLinks,
    reporterId: userId,
    assigneeId,
    categoryId,
    // Reporter and assignee watch the issue from the start (#216).
    watches: {
      create: [...new Set([userId, assigneeId].filter((id): id is string => Boolean(id)))].map(
        (watcherId) => ({ userId: watcherId }),
      ),
    },
    activities: {
      create: {
        actorId: userId,
        type: "created" as const,
        summary: createdSummary(parsed.data.title),
        metadata: {
          field: "title",
          to: parsed.data.title,
        } as Prisma.InputJsonValue,
      },
    },
  };

  let bug;
  try {
    bug = await prisma.bug.create({ data: issueData });
  } catch (error) {
    const foreignKey = foreignKeyError(error);
    if (foreignKey) return { error: foreignKey };
    // The issue-number sequence can sit behind MAX(number) and then every
    // create hits a unique violation, which the form shows as a 500.
    if (isBugNumberConflict(error)) {
      try {
        await repairBugNumberSequence(prisma);
        bug = await prisma.bug.create({ data: issueData });
      } catch (retryError) {
        const retryForeignKey = foreignKeyError(retryError);
        if (retryForeignKey) return { error: retryForeignKey };
        console.error("[issues] create failed after repairing the issue number", retryError);
        return { error: "Could not save the issue. Try again." };
      }
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { error: "That issue could not be saved because it conflicts with an existing one. Try again." };
    } else {
      throw error;
    }
  }

  // Files uploaded while writing the report (#215).
  // …and images pasted or dropped into the description (#305).
  await linkAttachments(prisma, {
    ids: [
      ...new Set([
        ...parseAttachmentIds(formData.get("attachmentIds")),
        ...attachmentIdsInMarkdown(description),
      ]),
    ],
    uploaderId: userId,
    bugId: bug.id,
  });

  // #600: agents hear about issues people file, not only ones agents file.
  // The issue already exists, so a failed event mustn't fail the report.
  try {
    await publishWebEvent(prisma, {
      bugId: bug.id,
      type: "issue.created",
      actorUserId: userId,
      payload: { reporterId: userId },
    });
  } catch (error) {
    console.error("[issues] issue.created event failed", error);
  }

  const events: NotificationEvent[] = [];
  const actor = { actorId: userId, actorName: user.name ?? "Someone", bugId: bug.id, bugTitle: bug.title };
  const mentioned = extractMentionedUserIds(description);
  if (mentioned.length > 0) {
    events.push({ ...actor, kind: "mentioned", place: "description", recipientIds: mentioned });
  }
  if (assigneeId) {
    events.push({ ...actor, kind: "assignee_changed", fromUserId: null, toUserId: assigneeId });
  }
  if (events.length > 0) notifyLater(...events);

  // Notify agent platform on feed (#764)
  try {
    if (prisma.agentEvent) {
      await publish(prisma, {
        tenantId,
        type: isReport ? "report.created" : "issue.created",
        payload: {
          issueId: bug.id,
          projectId,
          beneficiaryUserId: userId,
          isReport,
        },
        bugId: bug.id,
      });
    }
  } catch (err) {
    // Non-fatal if agent events / webhooks are not configured in test environment
    console.warn("[createBugAction] could not publish agent event", err);
  }

  revalidatePath("/issues");
  revalidatePath("/bugs");
  redirect(`/issues/${bug.id}`);
}

/** Updates status (assignee/admin) and severity/assignee (admin) and logs activity. */
export async function updateBugAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;
  const access = await currentTenantAccess(userId, user.role);
  const admin = access.admin;

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    include: {
      assignee: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
      type: { select: { id: true, name: true } },
      milestone: { select: { id: true, title: true } },
    },
  });
  if (!existing || existing.isDeleted) {
    return { error: "Issue not found" };
  }

  const isAssignee = existing.assigneeId === userId;
  const assigneeRaw = formData.get("assigneeId");
  const hasAssigneeField = assigneeRaw !== null && assigneeRaw !== undefined;
  const targetAssigneeId = hasAssigneeField
    ? assigneeRaw === "" || assigneeRaw === "unassigned"
      ? null
      : typeof assigneeRaw === "string"
        ? assigneeRaw.trim()
        : null
    : undefined;

  const isSelfAssigning =
    targetAssigneeId !== undefined && targetAssigneeId === userId;

  // #202: `status` is a triage field and must be gated on the issue's current
  // assignee (or an admin) - never on the assignee this request is trying to
  // set. Without this, a self-assignment satisfied the gate above and the same
  // request could also close/reopen the issue, letting any user close any
  // unassigned issue. Checked before schema parsing so the error is explicit.
  const requestedStatus = formData.get("status") || undefined;
  if (
    requestedStatus &&
    !canChangeTicketStatus({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: existing.assigneeId,
    })
  ) {
    return { error: TICKET_TRIAGE_ERRORS.statusUnauthorized };
  }

  if (!admin && !isAssignee && !isSelfAssigning) {
    return {
      error: "Only the assignee, or an owner or admin of this organization, can update this issue",
    };
  }

  if (targetAssigneeId !== undefined && targetAssigneeId !== existing.assigneeId) {
    if (
      !canAssignTicket({
        actorId: userId,
        actorRole: user.role,
        membershipRole: access.membershipRole,
        currentAssigneeId: existing.assigneeId,
        targetAssigneeId,
        voteCount: existing.voteCount,
      })
    ) {
      if (targetAssigneeId && typeof existing.voteCount === "number" && existing.voteCount < 3) {
        return { error: TICKET_ASSIGN_ERRORS.needsVotes };
      }
      return { error: TICKET_ASSIGN_ERRORS.unauthorized };
    }
  }

  const categoryRaw = formData.get("categoryId");
  const typeRaw = formData.get("typeId");
  const parsed = updateBugSchema.safeParse({
    status: requestedStatus,
    severity: admin ? formData.get("severity") || undefined : undefined,
    typeId: admin
      ? typeRaw === "" || typeRaw === "none"
        ? null
        : typeRaw || undefined
      : undefined,
    assigneeId: targetAssigneeId,
    categoryId: admin
      ? categoryRaw === "" || categoryRaw === "none"
        ? null
        : categoryRaw || undefined
      : undefined,
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  // Claiming an issue doesn't also grant its status in the same request: a
  // normal user who isn't the assignee yet must assign themselves first
  // (#218, #175).
  if (
    !admin &&
    !isAssignee &&
    parsed.data.status &&
    parsed.data.status !== existing.status
  ) {
    return { error: TICKET_ASSIGN_ERRORS.statusNeedsAssignment };
  }

  // #316: an optional note, only for a change into resolved or closed.
  const parsedNote = parseResolutionNote(formData.get("resolutionNote"), {
    from: existing.status,
    to: parsed.data.status,
  });
  if ("error" in parsedNote) return { error: parsedNote.error, field: "resolutionNote" };
  const resolutionNote = parsedNote.note;

  const data: {
    status?: typeof parsed.data.status;
    severity?: typeof parsed.data.severity;
    typeId?: string | null;
    assigneeId?: string | null;
    categoryId?: string | null;
    milestoneId?: string | null;
    isBoosted?: boolean;
    boostedAt?: Date | null;
  } = {};

  if (parsed.data.status) data.status = parsed.data.status;
  if (admin) {
    if (parsed.data.severity) data.severity = parsed.data.severity;
    if (parsed.data.typeId !== undefined) {
      data.typeId = parsed.data.typeId === "" ? null : parsed.data.typeId;
    }
    if (parsed.data.categoryId !== undefined) {
      data.categoryId =
        parsed.data.categoryId === "" ? null : parsed.data.categoryId;
    }
  }
  if (parsed.data.assigneeId !== undefined) {
    data.assigneeId =
      parsed.data.assigneeId === "" ? null : parsed.data.assigneeId;
  }

  type PendingActivity = {
    type: ActivityType;
    summary: string;
    metadata?: ActivityMetadata;
  };
  const pending: PendingActivity[] = [];

  if (data.status && data.status !== existing.status) {
    pending.push({
      type: "status_changed",
      summary: statusChangedSummary(existing.status, data.status),
      metadata: {
        field: "status",
        from: existing.status,
        to: data.status,
        ...(resolutionNote ? { note: resolutionNote } : {}),
      },
    });
  }

  // #256: a resolved or closed issue shouldn't stay pinned above open work.
  if (
    shouldUnboostOnStatusChange({
      isBoosted: existing.isBoosted,
      from: existing.status,
      to: data.status,
    })
  ) {
    data.isBoosted = false;
    data.boostedAt = null;
    pending.push({
      type: "unboosted",
      summary: unboostedSummary(),
      metadata: { field: "isBoosted", to: "false" },
    });
  }

  if (data.severity && data.severity !== existing.severity) {
    pending.push({
      type: "severity_changed",
      summary: severityChangedSummary(existing.severity, data.severity),
      metadata: {
        field: "severity",
        from: existing.severity,
        to: data.severity,
      },
    });
  }

  if (
    data.assigneeId !== undefined &&
    data.assigneeId !== existing.assigneeId
  ) {
    let toName: string | null = null;
    if (data.assigneeId) {
      const nextAssignee = await prisma.user.findUnique({
        where: { id: data.assigneeId },
        select: { name: true },
      });
      if (!nextAssignee) {
        return { error: "Assignee not found" };
      }
      toName = nextAssignee.name ?? null;
    }
    pending.push({
      type: "assignee_changed",
      summary: assigneeChangedSummary(existing.assignee?.name ?? null, toName),
      metadata: {
        field: "assigneeId",
        from: existing.assigneeId,
        to: data.assigneeId,
      },
    });
  }

  if (data.typeId !== undefined && data.typeId !== existing.typeId) {
    let toName: string | null = null;
    if (data.typeId) {
      const nextType = await prisma.issueType.findUnique({
        where: { id: data.typeId },
        select: { id: true, name: true, isActive: true },
      });
      if (!nextType || !nextType.isActive) {
        return { error: "That type no longer exists. Please pick another." };
      }
      toName = nextType.name;
    }
    pending.push({
      type: "type_changed",
      summary: typeChangedSummary(existing.type?.name ?? null, toName),
      metadata: {
        field: "type",
        from: existing.type?.name ?? null,
        to: toName,
      },
    });
  }

  if (
    data.categoryId !== undefined &&
    data.categoryId !== existing.categoryId
  ) {
    let toName: string | null = null;
    if (data.categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: data.categoryId, tenantId: existing.tenantId },
        select: { id: true, name: true },
      });
      if (!cat) {
        return { error: "Platform not found" };
      }
      toName = cat.name;
    }
    pending.push({
      type: "category_changed",
      summary: categoryChangedSummary(existing.category?.name ?? null, toName),
      metadata: {
        field: "category",
        from: existing.category?.name ?? null,
        to: toName,
      },
    });
  } else if (data.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: data.categoryId, tenantId: existing.tenantId },
      select: { id: true },
    });
    if (!cat) {
      return { error: "Platform not found" };
    }
  }

  // #289: admins put an issue in at most one milestone. Absent from the
  // form means "leave it"; "" or "none" takes it out.
  const milestoneRaw = admin ? formData.get("milestoneId") : null;
  if (typeof milestoneRaw === "string") {
    const nextMilestoneId = milestoneRaw === "" || milestoneRaw === "none" ? null : milestoneRaw.trim();
    if (nextMilestoneId !== existing.milestoneId) {
      let toTitle: string | null = null;
      if (nextMilestoneId) {
        const milestone = await prisma.milestone.findUnique({
          where: { id: nextMilestoneId },
          select: { title: true, isClosed: true },
        });
        if (!milestone) return fieldError("milestoneId", "That milestone no longer exists.");
        if (milestone.isClosed) {
          return fieldError("milestoneId", `"${milestone.title}" is closed. Reopen it to add issues.`);
        }
        toTitle = milestone.title;
      }
      data.milestoneId = nextMilestoneId;
      const fromTitle = existing.milestone?.title ?? null;
      pending.push({
        type: "milestone_changed",
        summary: toTitle
          ? fromTitle
            ? `moved this from milestone "${fromTitle}" to "${toTitle}"`
            : `added this to milestone "${toTitle}"`
          : `removed this from milestone "${fromTitle}"`,
        metadata: { field: "milestone", from: fromTitle, to: toTitle },
      });
    }
  }

  if (pending.length === 0 && Object.keys(data).length === 0) {
    return { ok: true };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize concurrent updates and prevent voteCount races.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      if (Object.keys(data).length > 0) {
        await tx.bug.update({
          where: { id: bugId },
          data,
        });
      }
      if (data.status === "resolved" || data.status === "closed") {
        await tx.issueClaim.updateMany({
          where: { bugId, status: "active", releasedAt: null },
          data: { status: "released", releasedAt: new Date(), releaseReason: data.status },
        });
      }
      if (data.assigneeId) {
        // The new assignee starts watching (#216).
        await ensureWatching(tx, bugId, [data.assigneeId]);
      }
      // #428: resolving an issue earns its assignee solver points, once.
      if (data.status === "resolved" && existing.status !== "resolved") {
        await awardSolver(tx, {
          id: bugId,
          tenantId: existing.tenantId,
          severity: data.severity ?? existing.severity,
          assigneeId: data.assigneeId !== undefined ? data.assigneeId : existing.assigneeId,
        });
      }
      if (pending.length > 0) {
        await tx.bugActivity.createMany({
          data: activityCreateData(
            pending.map((entry) => ({
              bugId,
              actorId: userId,
              ...entry,
            })),
          ),
        });
      }
      // #600: triage from the web app reaches agents too.
      if (Object.keys(data).length > 0) {
        await publishWebEvent(tx, {
          bugId,
          type: "issue.updated",
          actorUserId: userId,
          payload: issueChangePayload(data as Record<string, unknown>),
        });
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return {
        error: getForeignKeyErrorMessage(
          error.meta as Record<string, unknown> | undefined,
        ),
      };
    }
    throw error;
  }

  const events: NotificationEvent[] = [];
  const actor = { actorId: userId, actorName: user.name ?? "Someone", bugId, bugTitle: existing.title };
  if (data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId) {
    events.push({ ...actor, kind: "assignee_changed", fromUserId: existing.assigneeId, toUserId: data.assigneeId });
  }
  if (data.status && data.status !== existing.status) {
    events.push({ ...actor, kind: "status_changed", reporterId: existing.reporterId, from: existing.status, to: data.status, note: resolutionNote });
  }
  if (events.length > 0) notifyLater(...events);

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/** Allows the reporter or an admin to edit an issue's title and description. */
export async function editBugContentAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `edit-bug:${userId}`,
    ACTION_RATE_LIMITS.editBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    select: {
      id: true,
      title: true,
      description: true,
      reporterId: true,
      beneficiaryUserId: true,
      tenantId: true,
      isDeleted: true,
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_EDIT_ERRORS.notFound };
  }

  if (
    !canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentTenantAccess(userId, user.role)).membershipRole,
      reporterId: existing.reporterId,
    })
  ) {
    return { error: TICKET_EDIT_ERRORS.unauthorized };
  }

  const parsed = editBugContentSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  const normalizedDescription = await normalizeMentionTags(parsed.data.description);
  const changedFields = getChangedEditFields(existing, {
    title: parsed.data.title,
    description: normalizedDescription,
  });

  if (changedFields.length === 0) {
    return { ok: true };
  }

  const summary = formatEditSummary(changedFields);

  await prisma.$transaction(async (tx) => {
    // #303: keep the version this edit replaces. Read again under a row
    // lock so two edits at once each store the version they replaced and
    // none goes missing from the history.
    const [previous] = await tx.$queryRaw<{ title: string; description: string }[]>`
      SELECT "title", "description" FROM "Bug" WHERE "id" = ${bugId} FOR UPDATE`;
    await tx.bugRevision.create({
      data: {
        bugId,
        title: previous?.title ?? existing.title,
        description: previous?.description ?? existing.description,
        editedById: userId,
      },
    });

    // #713: Editing an issue invalidates confirmations and previous validations,
    // and reverses any reporter points awarded for the replaced report.
    type OptionalTxExtensions = {
      pointEntry?: {
        findFirst?: (args: unknown) => Promise<{ id: string; tenantId: string; userId: string; bugId: string | null; role: "solver" | "reporter" | "reviewer"; points: number } | null>;
        update?: (args: unknown) => Promise<unknown>;
      };
      issueValidation?: {
        deleteMany?: (args: unknown) => Promise<unknown>;
      };
    };
    const txExtensions = tx as unknown as OptionalTxExtensions;

    const wasConfirmed = await isConfirmed(bugId, tx);
    if (wasConfirmed) {
      const recipientId = existing.beneficiaryUserId ?? existing.reporterId;
      const tenantId = existing.tenantId ?? (await currentTenantIdFor(userId));
      if (recipientId && typeof txExtensions.pointEntry?.findFirst === "function") {
        const entry = await txExtensions.pointEntry.findFirst({
          where: {
            tenantId,
            sourceKey: pointSourceKey("reporter", bugId, recipientId),
          },
          select: { id: true, tenantId: true, userId: true, bugId: true, role: true, points: true },
        });
        if (entry) {
          await correct(tx, { entry });
          if (typeof txExtensions.pointEntry?.update === "function") {
            await txExtensions.pointEntry.update({
              where: { id: entry.id },
              data: {
                sourceKey: `${pointSourceKey("reporter", bugId, recipientId)}:invalidated:${entry.id}`,
              },
            });
          }
        }
      }
    }

    if (typeof txExtensions.issueValidation?.deleteMany === "function") {
      await txExtensions.issueValidation.deleteMany({
        where: { bugId },
      });
    }

    await tx.bug.update({
      where: { id: bugId },
      data: {
        title: parsed.data.title,
        description: normalizedDescription,
        updatedAt: new Date(),
      },
    });

    // Images pasted into the edited description (#305); only the editor's
    // own, not-yet-linked uploads are claimed.
    await linkAttachments(tx, {
      ids: attachmentIdsInMarkdown(normalizedDescription),
      uploaderId: userId,
      bugId,
    });
    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: userId,
      payload: issueChangePayload(
        Object.fromEntries(
          changedFields.map((field) => [field, field === "title" ? parsed.data.title : normalizedDescription]),
        ),
      ),
    });

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "edited",
        summary,
        metadata: {
          fields: changedFields,
        },
      },
    });
  });

  const newlyMentioned = newlyMentionedUserIds(
    existing.description,
    normalizedDescription,
  );
  if (newlyMentioned.length > 0) {
    notifyLater({
      kind: "mentioned",
      actorId: userId,
      actorName: user.name ?? "Someone",
      bugId,
      bugTitle: parsed.data.title,
      place: "description",
      recipientIds: newlyMentioned,
    });
  }

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Lets the reporter or an admin add, correct, or remove an issue's proof
 * links after filing (#737). Same rules as create: GitHub URLs, at most 20.
 */
export async function editProofLinksAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `edit-bug:${userId}`,
    ACTION_RATE_LIMITS.editBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    select: {
      id: true,
      proofLinks: true,
      reporterId: true,
      isDeleted: true,
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_EDIT_ERRORS.notFound };
  }

  if (
    !canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentTenantAccess(userId, user.role)).membershipRole,
      reporterId: existing.reporterId,
    })
  ) {
    return { error: TICKET_EDIT_ERRORS.unauthorized };
  }

  const parsed = editProofLinksSchema.safeParse({
    proofLinks: formData.get("proofLinks") || "",
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  const proofLinks = parsed.data.proofLinks;
  const changes = getProofLinkChanges(existing.proofLinks ?? [], proofLinks);
  if (changes.added.length === 0 && changes.removed.length === 0) {
    return { ok: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.bug.update({
      where: { id: bugId },
      data: { proofLinks, updatedAt: new Date() },
    });

    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: userId,
      payload: issueChangePayload({ proofLinks }),
    });

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "edited",
        summary: formatProofLinkSummary(changes),
        metadata: {
          fields: ["proofLinks"],
          added: changes.added,
          removed: changes.removed,
        },
      },
    });
  });

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/** Adds a (possibly threaded) comment to a bug and records the activity. */
export async function addCommentAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId();

  const limit = await consumeRateLimit(
    `add-comment:${userId}`,
    ACTION_RATE_LIMITS.addComment,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  let metadata: Record<string, unknown> | undefined;
  const metadataRaw = formData.get("metadata");
  if (typeof metadataRaw === "string" && metadataRaw.trim()) {
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      // ignore invalid json metadata
    }
  }

  const parsed = commentSchema.safeParse({
    body: formData.get("body"),
    parentId: formData.get("parentId") || undefined,
    type: formData.get("type") || undefined,
    metadata,
  });

  if (!parsed.success) {
    return fromZodError(parsed.error, "Invalid comment");
  }

  const bug = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    select: { id: true, isDeleted: true, title: true, reporterId: true, assigneeId: true },
  });
  if (!bug || bug.isDeleted) {
    return { error: "Issue not found" };
  }

  const parentId = parsed.data.parentId;
  let parentAuthorId: string | null = null;

  if (parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: parentId },
      select: { id: true, bugId: true, parentId: true, deletedAt: true, authorId: true },
    });

    if (!parent || parent.bugId !== bugId) {
      return { error: "Parent comment not found on this issue" };
    }
    if (parent.deletedAt) {
      return { error: "You can't reply to a deleted comment" };
    }
    parentAuthorId = parent.authorId;

    const threadComments = await prisma.comment.findMany({
      where: { bugId },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(
      threadComments.map((c) => [c.id, c.parentId] as const),
    );
    const parentDepth = commentDepth(parent.id, parentById);

    if (parentDepth >= MAX_COMMENT_DEPTH) {
      return {
        error: `Replies are limited to ${MAX_COMMENT_DEPTH} levels of nesting`,
      };
    }
  }

  const normalizedBody = await normalizeMentionTags(parsed.data.body);

  const commentId = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        bugId,
        authorId: userId,
        body: normalizedBody,
        parentId: parentId ?? null,
        type: parsed.data.type ?? "comment",
        metadata: parsed.data.metadata ? (parsed.data.metadata as Prisma.InputJsonValue) : undefined,
      },
      select: { id: true },
    });
    // Files uploaded with the comment (#215).
    await linkAttachments(tx, {
      ids: [
        ...new Set([
          ...parseAttachmentIds(formData.get("attachmentIds")),
          ...attachmentIdsInMarkdown(normalizedBody),
        ]),
      ],
      uploaderId: userId,
      bugId,
      commentId: created.id,
    });
    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "commented",
        summary: commentedSummary(normalizedBody),
        metadata: {
          field: "comment",
          commentId: created.id,
          commentPreview: commentPreview(normalizedBody),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.bug.update({
      where: { id: bugId },
      data: { updatedAt: new Date() },
    });
    // Commenting on an issue means you want to hear about replies (#216).
    await ensureWatching(tx, bugId, [userId]);
    // #600: a person's reply reaches the agents polling /api/v1/events.
    await publishWebEvent(tx, {
      bugId,
      type: "comment.created",
      actorUserId: userId,
      payload: { commentId: created.id, parentId: parentId ?? null, authorId: userId },
    });
    return created.id;
  });

  const mentioned = extractMentionedUserIds(normalizedBody);
  const author = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const actor = {
    actorId: userId,
    actorName: author?.name ?? "Someone",
    bugId,
    bugTitle: bug.title,
  };
  const excerpt = commentPreview(normalizedBody);
  const events: NotificationEvent[] = [];
  if (mentioned.length > 0) {
    events.push({ ...actor, kind: "mentioned", place: "comment", recipientIds: mentioned, excerpt, commentId });
  }
  // Watchers hear about every new comment (#216). The reporter and assignee
  // are the default audience; delivery adds anyone else watching.
  events.push({
    ...actor,
    kind: "comment_added",
    commentId,
    excerpt,
    parentAuthorId,
    recipientIds: [bug.reporterId, bug.assigneeId].filter((id): id is string => Boolean(id)),
    excludeIds: mentioned,
  });
  notifyLater(...events);

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

export type ToggleVoteResult = ActionResult & {
  voted?: boolean;
  userVote?: number;
  voteCount?: number;
  likeCount?: number;
  dislikeCount?: number;
};

/** Toggles the current user's reaction on a bug; rejects any direction other than 1 or -1. */
export async function toggleVoteAction(
  bugId: string,
  direction: unknown = 1,
): Promise<ToggleVoteResult> {
  if (!isValidVoteDirection(direction)) {
    return { error: "Invalid vote" };
  }

  // Do not redirect here — VoteButton needs a clear error for stale JWTs
  // after a DB reseed (old cuid no longer exists → Vote_userId_fkey).
  const resolved = await resolveSessionUserId();
  if ("error" in resolved) {
    return { error: SESSION_EXPIRED_MESSAGE };
  }
  const { userId } = resolved;

  const limit = await consumeRateLimit(
    `toggle-vote:${userId}`,
    ACTION_RATE_LIMITS.toggleVote,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const bug = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    select: { id: true, isDeleted: true },
  });
  if (!bug || bug.isDeleted) {
    return { error: "Issue not found" };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Acquire a row lock on the Bug to serialize concurrent vote updates
    // and prevent race-condition drift in voteCount (#362).
    await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;

    const existing = await tx.vote.findUnique({
      where: { userId_bugId: { userId, bugId } },
    });

    const currentVote = existing?.value ?? 0;
    const { nextVote } = calculateVoteChange(currentVote, direction);

    if (nextVote === 0 && existing) {
      await tx.vote.delete({ where: { id: existing.id } });
    } else if (existing) {
      await tx.vote.update({
        where: { id: existing.id },
        data: { value: nextVote },
      });
    } else {
      await tx.vote.create({
        data: { userId, bugId, value: nextVote },
      });
    }

    const voteCounts = await tx.vote.groupBy({
      by: ["value"],
      where: { bugId },
      _count: { _all: true },
    });

    let likeCount = 0;
    let dislikeCount = 0;
    for (const c of voteCounts) {
      if (c.value === 1) likeCount = c._count._all;
      if (c.value === -1) dislikeCount = c._count._all;
    }

    const voteCount = reconcileVoteCount(likeCount, dislikeCount);

    await tx.bug.update({
      where: { id: bugId },
      data: { voteCount },
    });

    return {
      voted: nextVote === 1,
      userVote: nextVote,
      voteCount,
      likeCount,
      dislikeCount,
    };
  });

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, ...result };
}

/**
 * Soft deletes a bug. Admins and super admins only.
 * The issue is hidden from normal views, but can be restored.
 */
export async function deleteBugAction(bugId: string): Promise<ActionResult> {
  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  if (!canDeleteTicket(user.role, access.membershipRole)) {
    return { error: TICKET_DELETION_ERRORS.unauthorized };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_DELETION_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(user.id)) },
    select: { id: true, isDeleted: true },
  });

  if (!existing) {
    return { error: TICKET_DELETION_ERRORS.notFound };
  }

  if (existing.isDeleted) {
    return { error: TICKET_DELETION_ERRORS.alreadyDeleted };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize with concurrent vote / update actions.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      await tx.bug.update({
        where: { id: bugId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      });
      // Delete attachments associated with the issue to prevent storage bloat (#658)
      await tx.attachment.deleteMany({ where: { bugId } });

      await publishWebEvent(tx, { bugId, type: "issue.deleted", actorUserId: user.id });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: "deleted",
          summary: deletedSummary(),
        },
      });
    });
  } catch (error) {
    console.error("Failed to delete bug:", error);
    return { error: TICKET_DELETION_ERRORS.failed };
  }

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  redirect("/issues");
}

/**
 * Restores a soft-deleted bug. Admins and super admins only.
 * Returns the issue back to active status in views and searches.
 */
export async function restoreBugAction(bugId: string): Promise<ActionResult> {
  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  if (!canRestoreTicket(user.role, access.membershipRole)) {
    return { error: TICKET_DELETION_ERRORS.unauthorizedRestore };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_DELETION_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(user.id)) },
    select: { id: true, isDeleted: true },
  });

  if (!existing) {
    return { error: TICKET_DELETION_ERRORS.notFound };
  }

  if (!existing.isDeleted) {
    return { error: TICKET_DELETION_ERRORS.notDeleted };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize with concurrent vote / update actions.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      // Reconcile voteCount from existing votes upon restoration (#676)
      let voteCount: number | undefined;
      if (tx.vote && typeof tx.vote.groupBy === "function") {
        const voteCounts = await tx.vote.groupBy({
          by: ["value"],
          where: { bugId },
          _count: { _all: true },
        });

        let likeCount = 0;
        let dislikeCount = 0;
        for (const c of voteCounts) {
          if (c.value === 1) likeCount = c._count._all;
          if (c.value === -1) dislikeCount = c._count._all;
        }

        voteCount = reconcileVoteCount(likeCount, dislikeCount);
      }

      await tx.bug.update({
        where: { id: bugId },
        data: {
          isDeleted: false,
          deletedAt: null,
          ...(voteCount !== undefined ? { voteCount } : {}),
        },
      });
      await publishWebEvent(tx, { bugId, type: "issue.restored", actorUserId: user.id });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: "restored",
          summary: restoredSummary(),
        },
      });
    });
  } catch (error) {
    console.error("Failed to restore bug:", error);
    return { error: TICKET_DELETION_ERRORS.failedRestore };
  }

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Toggles the boosted status of a bug. Admins and super admins only.
 * When boosted, the ticket appears pinned to the top of the list regardless of vote count.
 */
export async function toggleBoostBugAction(
  bugId: string,
): Promise<ActionResult & { isBoosted?: boolean }> {
  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  if (!canBoostTicket(user.role, access.membershipRole)) {
    return { error: TICKET_BOOST_ERRORS.unauthorized };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_BOOST_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(user.id)) },
    select: { id: true, isBoosted: true, isDeleted: true },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_BOOST_ERRORS.notFound };
  }

  const nextBoosted = !existing.isBoosted;
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.bug.update({
        where: { id: bugId },
        data: {
          isBoosted: nextBoosted,
          boostedAt: nextBoosted ? now : null,
        },
      });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: nextBoosted ? "boosted" : "unboosted",
          summary: nextBoosted ? boostedSummary() : unboostedSummary(),
          metadata: {
            field: "isBoosted",
            to: String(nextBoosted),
          } as Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    console.error("Failed to toggle bug boost:", error);
    return { error: TICKET_BOOST_ERRORS.failed };
  }

  revalidatePath("/issues");
  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, isBoosted: nextBoosted };
}

/**
 * Allows a user to assign an issue to themselves, or unassign if currently assigned.
 * Validates permission via canAssignTicket.
 */
export async function selfAssignBugAction(
  bugId: string,
  assign: boolean = true,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `self-assign:${userId}`,
    ACTION_RATE_LIMITS.selfAssign,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_ASSIGN_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInTenant(await currentTenantIdFor(userId)) },
    select: {
      id: true,
      title: true,
      assigneeId: true,
      isDeleted: true,
      voteCount: true,
      assignee: { select: { name: true } },
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_ASSIGN_ERRORS.notFound };
  }

  const targetAssigneeId = assign ? userId : null;

  if (
    !canAssignTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentTenantAccess(userId, user.role)).membershipRole,
      currentAssigneeId: existing.assigneeId,
      targetAssigneeId,
      voteCount: existing.voteCount,
    })
  ) {
    if (assign && typeof existing.voteCount === "number" && existing.voteCount < 3) {
      return { error: TICKET_ASSIGN_ERRORS.needsVotes };
    }
    return { error: TICKET_ASSIGN_ERRORS.unauthorized };
  }

  if (existing.assigneeId === targetAssigneeId) {
    return { ok: true };
  }

  const toName = targetAssigneeId ? user.name ?? null : null;

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize concurrent assignment and vote checks.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      await tx.bug.update({
        where: { id: bugId },
        data: { assigneeId: targetAssigneeId },
      });
      // Taking an issue means watching it (#216).
      await ensureWatching(tx, bugId, [targetAssigneeId]);

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: userId,
          type: "assignee_changed",
          summary: assigneeChangedSummary(
            existing.assignee?.name ?? null,
            toName,
          ),
          metadata: {
            field: "assigneeId",
            from: existing.assigneeId,
            to: targetAssigneeId,
          },
        },
      });
      await publishWebEvent(tx, {
        bugId,
        type: "issue.updated",
        actorUserId: userId,
        payload: issueChangePayload({ assigneeId: targetAssigneeId }),
      });
    });
  } catch (error) {
    console.error("Failed to self-assign issue:", error);
    return { error: TICKET_ASSIGN_ERRORS.failed };
  }

  notifyLater({
    kind: "assignee_changed",
    actorId: userId,
    actorName: user.name ?? "Someone",
    bugId,
    bugTitle: existing.title,
    fromUserId: existing.assigneeId,
    toUserId: targetAssigneeId,
  });

  revalidatePath(`/issues/${bugId}`);
  revalidatePath("/issues");
  revalidatePath(`/bugs/${bugId}`);
  revalidatePath("/bugs");
  return { ok: true };
}


