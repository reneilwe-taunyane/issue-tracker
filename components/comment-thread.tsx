"use client";

import { useState, useTransition } from "react";
import { LocalTime } from "@/components/local-time";
import {
  MAX_COMMENT_DEPTH,
  truncateCommentBody,
  type CommentNode,
} from "@/lib/comments";
import { canDeleteComment, canEditComment } from "@/lib/comment-permissions";
import type { AppRole } from "@/lib/roles";
import type { CommentType } from "@/lib/validations/issue";
import { deleteCommentAction, updateCommentAction } from "@/app/actions/comments";
import { Button } from "@/components/ui/button";
import { CommentBody, MentionText } from "@/components/comment-body";
import { CommentForm } from "@/components/comment-form";
import { MarkdownEditor } from "@/components/markdown-editor";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { CopyLinkButton } from "@/components/copy-link-button";
import { AttachmentList, type AttachmentView } from "@/components/attachment-list";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";

type AttachmentsByComment = Record<string, AttachmentView[]>;

type UserOption = { id: string; name: string };

function CommentTypeBadge({ type, metadata }: { type?: CommentType | null; metadata?: unknown }) {
  if (!type || type === "comment") return null;

  const meta = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : null;

  switch (type) {
    case "bid":
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
          <span>🏷️</span>
          <span>Bid</span>
          {typeof meta?.eta === "string" ? <span className="text-amber-700">· ETA: {meta.eta}</span> : null}
        </span>
      );
    case "review":
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-800 border border-purple-200">
          <span>🔍</span>
          <span>Review</span>
          {typeof meta?.verdict === "string" ? <span className="text-purple-700">· {meta.verdict}</span> : null}
        </span>
      );
    case "delivery":
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 border border-emerald-200">
          <span>📦</span>
          <span>Delivery</span>
          {typeof meta?.prUrl === "string" ? (
            <a href={meta.prUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-900">
              PR
            </a>
          ) : null}
        </span>
      );
    case "request_to_merge":
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 border border-rose-200">
          <span>🔀</span>
          <span>Request to Merge</span>
        </span>
      );
    default:
      return null;
  }
}

function commentCardStyle(type?: CommentType | null): string {
  switch (type) {
    case "bid":
      return "border-amber-200 bg-amber-50/30";
    case "review":
      return "border-purple-200 bg-purple-50/30";
    case "delivery":
      return "border-emerald-200 bg-emerald-50/30";
    case "request_to_merge":
      return "border-rose-200 bg-rose-50/30 ring-1 ring-rose-200";
    default:
      return "border-slate-100 bg-slate-50";
  }
}

type ViewerProps = {
  currentUserId?: string;
  currentUserRole?: AppRole | null;
  /** Owner, admin, or site super admin of this issue's organization. */
  tenantAdmin?: boolean;
  /** Deleted issues: show comments but no reply, edit, delete or new comment. */
  readOnly?: boolean;
};

function CommentEditForm({
  comment,
  users,
  onDone,
}: {
  comment: CommentNode;
  users: UserOption[];
  onDone: () => void;
}) {
  const [body, setBody] = useState(comment.body);
  const [editorUploading, setEditorUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const unchanged = body.trim() === comment.body.trim();

  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(event) => {
        if (pending || editorUploading) {
          event.preventDefault();
        }
      }}
      action={(formData) => {
        if (pending || editorUploading) return;
        setError(null);
        startTransition(async () => {
          const result = await updateCommentAction(comment.id, formData);
          if (result.error) setError(result.error);
          else onDone();
        });
      }}
    >
      <MarkdownEditor
        id={`edit-${comment.id}`}
        name="body"
        required
        rows={3}
        maxLength={2000}
        value={body}
        onChange={setBody}
        onUploadingChange={setEditorUploading}
        users={users}
        renderMentions={(text) => <MentionText text={text} users={users} />}
        aria-label="Edit comment"
      />
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !body.trim() || unchanged || editorUploading}>
          {pending ? "Saving…" : editorUploading ? "Uploading…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CommentItem({
  comment,
  bugId,
  issueUrl,
  reporterId,
  users,
  currentUserId,
  currentUserRole,
  tenantAdmin = false,
  attachmentsByComment = {},
  readOnly = false,
}: {
  comment: CommentNode;
  bugId: string;
  /** Canonical issue URL, for each comment's permalink (#279). */
  issueUrl: string;
  reporterId: string;
  users: UserOption[];
  attachmentsByComment?: AttachmentsByComment;
} & ViewerProps) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const toast = useToast();
  const isDeleted = Boolean(comment.deletedAt);
  const canReply =
    !readOnly && comment.depth < MAX_COMMENT_DEPTH && !isDeleted;
  const canEdit = !readOnly && canEditComment(currentUserId, comment);
  const canDelete =
    !readOnly && canDeleteComment(currentUserId, currentUserRole, comment, tenantAdmin);

  const handleDelete = async () => {
    const own = comment.authorId === currentUserId;
    const confirmed = await confirm({
      title: own ? "Delete your comment?" : `Delete ${comment.author.name}'s comment?`,
      body: own
        ? "Replies will stay, and the comment will show as deleted."
        : "This is recorded in the activity log.",
      confirmLabel: "Delete comment",
      tone: "danger",
    });
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteCommentAction(comment.id);
      if (result.error) {
        setError(result.error);
        toast(result.error, "error");
      } else {
        toast("Comment deleted.");
      }
    });
  };

  return (
    <li
      id={`comment-${comment.id}`}
      // :target is the comment a permalink points at (#279); the highlight
      // needs no script, so it works on first load and on hash changes.
      // break-inside keeps a comment whole across printed pages (#300).
      className="group/comment scroll-mt-24 space-y-3 break-inside-avoid"
    >
      <article
        className={`rounded-lg border px-4 py-3 group-target/comment:border-teal-400 group-target/comment:bg-teal-50 group-target/comment:ring-2 group-target/comment:ring-teal-500/40 motion-safe:transition-colors ${commentCardStyle(comment.type)} ${
          comment.depth > 0 ? "border-l-2 border-l-teal-600" : ""
        }`}
      >
        {isDeleted ? (
          <p className="text-sm italic text-slate-500">This comment was deleted.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-slate-500">
              <div className="flex flex-wrap items-center gap-2">
                <UserNameWithBadges
                  name={comment.author.name}
                  role={comment.author.role}
                  image={comment.author.image}
                  avatar="sm"
                  userId={comment.authorId}
                  showAuthor={comment.authorId === reporterId}
                  agentName={comment.agent?.name}
                  className="font-medium text-slate-700"
                />
                <CommentTypeBadge type={comment.type} metadata={comment.metadata} />
              </div>
              <span className="inline-flex items-center gap-1.5">
                <a
                  href={`#comment-${comment.id}`}
                  className="hover:text-slate-700 hover:underline"
                >
                  <LocalTime date={comment.createdAt} />
                </a>
                <CopyLinkButton
                  url={`${issueUrl}#comment-${comment.id}`}
                  label="comment"
                  compact
                />
                {comment.editedAt ? (
                  <span title="This comment was edited">· edited</span>
                ) : null}
              </span>
            </div>

            {comment.parent ? (
              <p className="mt-2 rounded-md bg-white/80 px-2.5 py-1.5 text-xs text-slate-500 break-words">
                Replying to{" "}
                <span className="font-medium text-slate-700">
                  {comment.parent.author.name}
                </span>
                {": "}
                <span className="italic text-slate-600">
                  {comment.parent.deletedAt
                    ? "deleted comment"
                    : truncateCommentBody(comment.parent.body)}
                </span>
              </p>
            ) : null}

            {editing ? (
              <CommentEditForm
                comment={comment}
                users={users}
                onDone={() => setEditing(false)}
              />
            ) : (
              <>
                <CommentBody body={comment.body} users={users} />
                <AttachmentList attachments={attachmentsByComment[comment.id] ?? []} />
              </>
            )}
          </>
        )}

        {!editing && (canReply || canEdit || canDelete) ? (
          <div className="mt-2">
            {replying ? (
              <CommentForm
                bugId={bugId}
                users={users}
                parentId={comment.id}
                parentAuthorName={comment.author.name}
                onCancel={() => setReplying(false)}
                onSuccess={() => setReplying(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-1">
                {canReply ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="px-2 py-1 text-xs text-teal-700 hover:text-teal-800"
                    onClick={() => setReplying(true)}
                  >
                    Reply
                  </Button>
                ) : null}
                {canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="px-2 py-1 text-xs text-slate-600 hover:text-slate-900"
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    className="px-2 py-1 text-xs text-slate-600 hover:text-red-700"
                    onClick={handleDelete}
                  >
                    {pending ? "Deleting…" : "Delete"}
                  </Button>
                ) : null}
              </div>
            )}
            {error ? (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </article>

      {comment.children.length > 0 ? (
        <ul className="ml-2.5 space-y-3 border-l border-slate-200 pl-2.5 sm:ml-6 sm:pl-4">
          {comment.children.map((child) => (
            <CommentItem
              key={child.id}
              comment={child}
              bugId={bugId}
              issueUrl={issueUrl}
              reporterId={reporterId}
              users={users}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              tenantAdmin={tenantAdmin}
              attachmentsByComment={attachmentsByComment}
              readOnly={readOnly}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CommentThread({
  bugId,
  issueUrl,
  reporterId,
  comments,
  users,
  currentUserId,
  currentUserRole,
  tenantAdmin = false,
  attachmentsByComment = {},
  readOnly = false,
}: {
  bugId: string;
  issueUrl: string;
  reporterId: string;
  comments: CommentNode[];
  users: UserOption[];
  /** Files attached to each comment, by comment id (#215). */
  attachmentsByComment?: AttachmentsByComment;
} & ViewerProps) {
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filteredComments = comments.filter((comment) => {
    if (typeFilter === "all") return true;
    const cType = comment.type || "comment";
    return cType === typeFilter;
  });

  return (
    <div className="mt-4 space-y-6">
      {comments.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 pb-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 mr-2">Filter:</span>
          {[
            { id: "all", label: "All" },
            { id: "comment", label: "Comments" },
            { id: "bid", label: "Bids" },
            { id: "review", label: "Reviews" },
            { id: "delivery", label: "Deliveries" },
            { id: "request_to_merge", label: "Merge Requests" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setTypeFilter(tab.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                typeFilter === tab.id
                  ? "bg-teal-700 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {filteredComments.length === 0 ? (
        <p className="text-sm text-slate-500">
          {comments.length > 0
            ? "No timeline entries match this filter."
            : readOnly
              ? "No conversation."
              : "No conversation yet. Start the conversation with a comment, bid, or instruction."}
        </p>
      ) : (
        <ul className="space-y-4">
          {filteredComments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              bugId={bugId}
              issueUrl={issueUrl}
              reporterId={reporterId}
              users={users}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              tenantAdmin={tenantAdmin}
              attachmentsByComment={attachmentsByComment}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
      {readOnly ? null : <CommentForm bugId={bugId} users={users} />}
    </div>
  );
}
