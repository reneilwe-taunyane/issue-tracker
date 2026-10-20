import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/actions/comments", () => ({
  deleteCommentAction: vi.fn(),
  updateCommentAction: vi.fn(),
  createCommentAction: vi.fn(),
}));

import { CommentThread } from "./comment-thread";
import type { CommentNode } from "@/lib/comments";

describe("CommentThread permalinks (#142)", () => {
  it("renders comment id, scroll-mt-24, and timestamp permalink anchor", () => {
    const comments: CommentNode[] = [
      {
        id: "c1",
        authorId: "u1",
        parentId: null,
        body: "First comment",
        createdAt: new Date("2026-10-16T12:00:00Z"),
        editedAt: null,
        deletedAt: null,
        depth: 0,
        author: {
          name: "Alice",
          role: "user",
        },
        parent: null,
        children: [],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(CommentThread, {
        bugId: "b1",
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "u1",
        comments,
        users: [{ id: "u1", name: "Alice" }],
      }),
    );

    expect(html).toContain('id="comment-c1"');
    expect(html).toContain("scroll-mt-24");
    expect(html).toContain('href="#comment-c1"');
    // A permalink copy control beside the timestamp, with a real name (#279).
    expect(html).toContain('aria-label="Copy link to this comment"');
  });
});

describe("CommentThread read-only mode (#122)", () => {
  const comments: CommentNode[] = [
    {
      id: "c1",
      authorId: "u1",
      parentId: null,
      body: "First comment",
      createdAt: new Date("2026-10-16T12:00:00Z"),
      editedAt: null,
      deletedAt: null,
      depth: 0,
      author: { name: "Alice", role: "user" },
      parent: null,
      children: [],
    },
  ];

  const render = (readOnly: boolean) =>
    renderToStaticMarkup(
      createElement(CommentThread, {
        bugId: "b1",
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "u1",
        comments,
        users: [{ id: "u1", name: "Alice" }],
        currentUserId: "u1",
        currentUserRole: "user",
        readOnly,
      }),
    );

  it("shows the comment form and Reply on a normal issue", () => {
    const html = render(false);
    expect(html).toContain("<form");
    expect(html).toContain(">Reply<");
  });

  it("renders structured comment badges like bid and delivery (#747)", () => {
    const comments: CommentNode[] = [
      {
        id: "c-bid",
        authorId: "u1",
        parentId: null,
        body: "I bid 2 hours",
        type: "bid",
        metadata: { eta: "2 hours" },
        createdAt: new Date("2026-10-16T12:00:00Z"),
        editedAt: null,
        deletedAt: null,
        depth: 0,
        author: { name: "Agent Alpha", role: "user" },
        parent: null,
        children: [],
      },
      {
        id: "c-del",
        authorId: "u1",
        parentId: null,
        body: "Delivered PR",
        type: "delivery",
        metadata: { prUrl: "https://github.com/pr/1" },
        createdAt: new Date("2026-10-16T12:00:00Z"),
        editedAt: null,
        deletedAt: null,
        depth: 0,
        author: { name: "Agent Alpha", role: "user" },
        parent: null,
        children: [],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(CommentThread, {
        bugId: "b1",
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "u1",
        comments,
        users: [{ id: "u1", name: "Agent Alpha" }],
      }),
    );

    expect(html).toContain("Bid");
    expect(html).toContain("ETA: 2 hours");
    expect(html).toContain("Delivery");
    expect(html).toContain('href="https://github.com/pr/1"');
  });
});
