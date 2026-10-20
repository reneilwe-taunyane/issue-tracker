import type { AppRole } from "@/lib/roles";
import { stripMarkdown } from "@/lib/rich-text";
import type { CommentType } from "@/lib/validations/issue";

/** Root = 0. Replies may nest up to this depth (3 levels total). */
export const MAX_COMMENT_DEPTH = 2;

export type CommentAuthor = { name: string; role?: AppRole | null; image?: string | null };

export type FlatComment = {
  id: string;
  body: string;
  type?: CommentType | null;
  metadata?: unknown;
  createdAt: Date | string;
  editedAt?: Date | string | null;
  deletedAt?: Date | string | null;
  parentId: string | null;
  authorId: string;
  author: CommentAuthor;
  agentId?: string | null;
  agent?: { name: string } | null;
  parent: {
    id: string;
    body: string;
    deletedAt?: Date | string | null;
    author: CommentAuthor;
  } | null;
};

export type CommentNode = FlatComment & {
  depth: number;
  children: CommentNode[];
};

/**
 * Comments that still have content. Deleted comments are soft-deleted and kept
 * so their replies stay threaded, but they don't count towards "Comments (N)" (#257).
 */
export function countVisibleComments(
  comments: readonly { deletedAt?: Date | string | null }[],
): number {
  return comments.filter((comment) => !comment.deletedAt).length;
}

/** Build a nested tree from a flat, chronological comment list. */
export function buildCommentTree(comments: FlatComment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();

  for (const comment of comments) {
    byId.set(comment.id, {
      ...comment,
      depth: 0,
      children: [],
    });
  }

  const roots: CommentNode[] = [];

  for (const comment of comments) {
    const node = byId.get(comment.id);
    if (!node) continue;

    if (comment.parentId) {
      const parent = byId.get(comment.parentId);
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
        continue;
      }
    }

    roots.push(node);
  }

  return roots;
}

/** Walk parent links to compute depth of an existing comment (root = 0). */
export function commentDepth(
  commentId: string,
  parentById: Map<string, string | null>,
): number {
  let depth = 0;
  let currentId: string | null = commentId;

  while (currentId) {
    const parentId: string | null = parentById.get(currentId) ?? null;
    if (!parentId) break;
    depth += 1;
    currentId = parentId;
    // Cap walks so cycles/orphaned chains cannot loop forever.
    if (depth >= MAX_COMMENT_DEPTH + 1) break;
  }

  return depth;
}

export function truncateCommentBody(body: string, max = 80): string {
  const trimmed = stripMarkdown(body).replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
