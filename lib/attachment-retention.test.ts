import { describe, expect, it, vi } from "vitest";
import { pruneUnlinkedUploads, SWEEP_BATCH, UNLINKED_UPLOAD_TTL_MS } from "./attachment-retention";

const now = new Date("2026-10-20T12:00:00Z");
const cutoff = new Date(now.getTime() - UNLINKED_UPLOAD_TTL_MS);
const unlinked = { bugId: null, commentId: null, redesignProposalId: null, createdAt: { lt: cutoff } };

function fakeDb(stale: string[] = []) {
  return {
    attachment: {
      deleteMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => ({ count: where.id ? where.id.in.length : 2 })),
      findMany: vi.fn(async () => stale.map((id) => ({ id }))),
    },
  };
}

describe("pruneUnlinkedUploads (#543)", () => {
  it("deletes only this uploader's uploads that were never attached and are over a week old", async () => {
    const db = fakeDb();
    const result = await pruneUnlinkedUploads(db as never, { uploaderId: "u1", now, siteSweep: false });
    expect(db.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.attachment.deleteMany).toHaveBeenCalledWith({ where: { uploaderId: "u1", ...unlinked } });
    expect(db.attachment.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ own: 2, site: 0 });
  });

  it("keeps uploads from the last week, so unsent drafts don't lose their images", () => {
    expect(UNLINKED_UPLOAD_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("sometimes sweeps everyone's expired uploads, in a bounded batch", async () => {
    const db = fakeDb(["a", "b", "c"]);
    const result = await pruneUnlinkedUploads(db as never, { uploaderId: "u1", now, siteSweep: true });
    expect(db.attachment.findMany).toHaveBeenCalledWith({ where: unlinked, select: { id: true }, take: SWEEP_BATCH });
    // The delete re-checks "still unlinked", so one attached in between survives.
    expect(db.attachment.deleteMany).toHaveBeenLastCalledWith({ where: { id: { in: ["a", "b", "c"] }, ...unlinked } });
    expect(result.site).toBe(3);
  });

  it("does nothing more when the sweep finds nothing", async () => {
    const db = fakeDb([]);
    await pruneUnlinkedUploads(db as never, { uploaderId: "u1", now, siteSweep: true });
    expect(db.attachment.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("sweepOrphanedAttachments (#658)", () => {
  it("purges unlinked uploads older than TTL and attachments of deleted bugs/comments", async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: "u-1" }, { id: "u-2" }]) // unlinked
      .mockResolvedValueOnce([{ id: "b-1" }]) // deleted bug
      .mockResolvedValueOnce([{ id: "c-1" }]); // deleted comment
    const deleteMany = vi.fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const db = { attachment: { findMany, deleteMany } };
    const { sweepOrphanedAttachments, ORPHANED_UPLOAD_TTL_MS } = await import("./attachment-retention");

    const result = await sweepOrphanedAttachments(db as never, { now, sweep: true });
    expect(result).toEqual({ unlinked: 2, deletedParents: 2, total: 4 });

    const cutoff = new Date(now.getTime() - ORPHANED_UPLOAD_TTL_MS);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { bugId: null, commentId: null, redesignProposalId: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { bug: { isDeleted: true } },
      select: { id: true },
      take: 500,
    });
    expect(findMany).toHaveBeenNthCalledWith(3, {
      where: { comment: { deletedAt: { not: null } } },
      select: { id: true },
      take: 500,
    });
  });

  it("skips execution when sweep is false", async () => {
    const findMany = vi.fn();
    const deleteMany = vi.fn();
    const db = { attachment: { findMany, deleteMany } };
    const { sweepOrphanedAttachments } = await import("./attachment-retention");

    const result = await sweepOrphanedAttachments(db as never, { now, sweep: false });
    expect(result).toEqual({ unlinked: 0, deletedParents: 0, total: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

