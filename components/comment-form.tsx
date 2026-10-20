"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { addCommentAction } from "@/app/actions/issues";
import { Button } from "@/components/ui/button";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { MentionText } from "@/components/comment-body";
import { AttachmentPicker } from "@/components/attachment-picker";
import { clearDraft, draftKey, readDraft, writeDraft } from "@/lib/comment-draft";
import type { CommentType } from "@/lib/validations/issue";

type UserOption = { id: string; name: string };

type CommentFormProps = {
  bugId: string;
  users: UserOption[];
  parentId?: string;
  parentAuthorName?: string;
  onCancel?: () => void;
  onSuccess?: () => void;
};

export function CommentForm({
  bugId,
  users,
  parentId,
  parentAuthorName,
  onCancel,
  onSuccess,
}: CommentFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const [body, setBody] = useState("");
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remounts the file picker after a successful post, clearing it (#215).
  const [pickerKey, setPickerKey] = useState(0);
  const [commentType, setCommentType] = useState<CommentType>("comment");
  const [pending, startTransition] = useTransition();
  const isReply = Boolean(parentId);
  const key = draftKey(bugId, parentId);
  const bodyId = parentId ? `body-${parentId}` : "body";
  const errorId = `${bodyId}-error`;
  const [bodyInvalid, setBodyInvalid] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const [pickerUploading, setPickerUploading] = useState(false);
  const isUploading = editorUploading || pickerUploading;

  // localStorage only exists on the client, so this cannot be a state
  // initializer without the server and client rendering different markup,
  // and setting state during the effect would be the cascading render the
  // lint rule warns about. A microtask after mount is the first safe moment.
  useEffect(() => {
    const saved = readDraft(localStorage, key);
    if (!saved) return;
    queueMicrotask(() => {
      // Don't stamp over anything typed in the moment before this ran.
      setBody((current) => (current ? current : saved));
      setRestored(true);
    });
  }, [key]);

  const update = useCallback(
    (next: string) => {
      setBody(next);
      setRestored(false);
      writeDraft(localStorage, key, next);
    },
    [key],
  );

  return (
    <form
      ref={formRef}
      className="space-y-3"
      onSubmit={(event) => {
        if (pending || isUploading) {
          event.preventDefault();
        }
      }}
      action={(formData) => {
        if (pending || isUploading) return;
        setError(null);
        setBodyInvalid(false);
        startTransition(async () => {
          const result = await addCommentAction(bugId, formData);
          if (result.error) {
            setError(result.error);
            // The only field is the body, so a field error is about it (#309).
            if (result.field) {
              setBodyInvalid(true);
              document.getElementById(bodyId)?.focus();
            }
          } else {
            setBody("");
            setRestored(false);
            clearDraft(localStorage, key);
            formRef.current?.reset();
            setPickerKey((k) => k + 1);
            onSuccess?.();
          }
        });
      }}
    >
      {parentId ? (
        <input type="hidden" name="parentId" value={parentId} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="comment-type-select" className="text-xs font-medium text-slate-600">
            Type:
          </label>
          <select
            id="comment-type-select"
            name="type"
            value={commentType}
            onChange={(e) => setCommentType(e.target.value as CommentType)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 shadow-xs focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="comment">💬 Comment</option>
            <option value="bid">🏷️ Bid</option>
            <option value="review">🔍 Review</option>
            <option value="delivery">📦 Delivery</option>
            <option value="request_to_merge">🔀 Request to Merge</option>
          </select>
        </div>
      )}
      <label
        id={`${parentId ? `body-${parentId}` : "body"}-label`}
        htmlFor={parentId ? `body-${parentId}` : "body"}
        className="block text-sm font-medium text-slate-700"
      >
        {isReply
          ? `Reply to ${parentAuthorName ?? "comment"}`
          : "Add to conversation"}
      </label>
      <MarkdownEditor
        ref={editorRef}
        id={parentId ? `body-${parentId}` : "body"}
        labelId={`${parentId ? `body-${parentId}` : "body"}-label`}
        name="body"
        required
        rows={isReply ? 3 : 4}
        maxLength={2000}
        disabled={pending}
        value={body}
        onChange={update}
        {...(bodyInvalid ? { "aria-invalid": true, "aria-describedby": errorId } : {})}
        users={users}
        renderMentions={(text) => <MentionText text={text} users={users} />}
        onUploadingChange={setEditorUploading}
        placeholder={
          isReply
            ? "Write your reply… Type @ to mention someone"
            : "Add to the conversation… Type @ to mention someone"
        }
        footer={
          !isReply ? (
            <p className="text-xs text-slate-500">
              Markdown is supported. People you @mention get an email (they
              can turn these off in Settings).
            </p>
          ) : null
        }
      />
      <AttachmentPicker
        key={pickerKey}
        disabled={pending}
        onUploadingChange={setPickerUploading}
      />
      {error ? (
        <p id={errorId} className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {restored ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600" role="status">
          <span>Restored an unsent draft.</span>
          <button
            type="button"
            className="rounded-sm font-medium text-teal-700 underline hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            onClick={() => update("")}
          >
            Discard it
          </button>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !body.trim() || isUploading}>
          {pending
            ? isReply
              ? "Replying…"
              : "Posting…"
            : isUploading
              ? "Uploading…"
              : isReply
                ? "Post reply"
                : "Post to conversation"}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
            // The draft stays saved: cancelling a reply is usually "not now",
            // and re-opening it restores what was typed.
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}