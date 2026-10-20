import type { PrismaClient, Prisma, PointRole } from "@prisma/client";
import { award } from "./award";

/**
 * Reverses a points entry by writing a correcting entry with negative points.
 * The original row is never edited or deleted; only `correctedAt` is stamped.
 *
 * The correction reuses the ledger's idempotency: its `sourceKey` is
 * `undo:{entryId}`, so undoing the same entry twice writes the correction only
 * once (#450). Rows are never deleted (#428, #436).
 */

export type PointEntryLike = {
  id: string;
  tenantId: string;
  userId: string;
  bugId: string | null;
  role: PointRole;
  points: number;
};

export function correctionSourceKey(pointEntryId: string): string {
  return `undo:${pointEntryId}`;
}

type Db = PrismaClient | Prisma.TransactionClient;

export type CorrectionResult = { awarded: boolean; entryId: string };

export async function correct(
  db: Db,
  args: { entry: PointEntryLike },
): Promise<CorrectionResult> {
  const { entry } = args;

  await db.pointEntry.update({
    where: { id: entry.id },
    data: { correctedAt: new Date() },
  });

  const awarded = await award(db, {
    tenantId: entry.tenantId,
    userId: entry.userId,
    bugId: entry.bugId,
    role: entry.role,
    points: -entry.points,
    sourceKey: correctionSourceKey(entry.id),
  });

  return { awarded, entryId: entry.id };
}
