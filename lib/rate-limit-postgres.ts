import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  RATE_LIMIT_RETENTION_MS,
  type RateLimitConfig,
  type RateLimitItem,
  type RateLimitResult,
  type RateLimitStore,
} from "@/lib/rate-limit";

/**
 * The shared rate-limit store (#296): one row per allowed attempt in
 * "RateLimitHit", read as a sliding window — the same semantics as the
 * in-memory limiter.
 *
 * Each check runs in a transaction holding a Postgres advisory lock on the
 * key, so two instances checking the same key at once can't both see
 * "one left" and both proceed.
 *
 * Multi-key checks (#678) run in a single transaction, holding advisory
 * locks on all keys in deterministic (sorted) order to prevent deadlocks,
 * and only record hits if all keys are within their respective limits.
 *
 * Keys are stored hashed: they contain email addresses and IPs, which have
 * no business sitting in a table for an hour.
 *
 * Times are epoch milliseconds in a BIGINT, which sidesteps any session
 * time zone between Node and Postgres.
 */

/** How often a check also deletes expired rows: roughly 1 in this many. */
const CLEANUP_EVERY = 200;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function hitMany(items: RateLimitItem[], now: number): Promise<RateLimitResult> {
  if (items.length === 0) return { allowed: true, retryAfterMs: 0 };

  const prepared = items.map((item) => ({
    ...item,
    hashed: hashKey(item.key),
    windowStart: BigInt(now - item.config.windowMs),
  }));

  // Distinct hashed keys sorted lexicographically to guarantee consistent lock ordering (prevents deadlocks)
  const distinctHashed = Array.from(new Set(prepared.map((p) => p.hashed))).sort();

  const result = await prisma.$transaction(async (tx) => {
    for (const h of distinctHashed) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${h}))`;
    }

    const blocked: RateLimitResult[] = [];
    const hitsToAdd = new Map<string, number>();
    // #646: what's left after this attempt, and when the window frees up,
    // from the count this check reads anyway. The tightest item wins.
    let remaining = Number.POSITIVE_INFINITY;
    let resetAfterMs = 0;

    for (const item of prepared) {
      const addedSoFar = hitsToAdd.get(item.hashed) ?? 0;
      const rows = await tx.$queryRaw<{ count: bigint; oldest: bigint | null }[]>`
        SELECT count(*)::bigint AS count, min("at") AS oldest
        FROM "RateLimitHit"
        WHERE "key" = ${item.hashed} AND "at" > ${item.windowStart}`;
      const count = Number(rows[0]?.count ?? 0) + addedSoFar;
      if (count >= item.config.max) {
        const oldest = rows[0]?.oldest != null ? Number(rows[0].oldest) : now;
        blocked.push({
          allowed: false,
          retryAfterMs: Math.max(0, oldest + item.config.windowMs - now),
        });
      } else {
        hitsToAdd.set(item.hashed, addedSoFar + 1);
        remaining = Math.min(remaining, item.config.max - (count + 1));
        const oldest = rows[0]?.oldest != null ? Number(rows[0].oldest) : now;
        resetAfterMs = Math.max(resetAfterMs, Math.max(0, oldest + item.config.windowMs - now));
      }
    }

    if (blocked.length > 0) {
      const retryAfterMs = Math.max(...blocked.map((b) => b.retryAfterMs));
      return { allowed: false, retryAfterMs, remaining: 0, resetAfterMs: retryAfterMs };
    }

    for (const item of prepared) {
      await tx.$executeRaw`INSERT INTO "RateLimitHit" ("key", "at") VALUES (${item.hashed}, ${BigInt(now)})`;
    }

    return {
      allowed: true,
      retryAfterMs: 0,
      ...(Number.isFinite(remaining) ? { remaining, resetAfterMs } : {}),
    };
  });

  if (Math.random() * CLEANUP_EVERY < 1) {
    const cutoff = BigInt(now - RATE_LIMIT_RETENTION_MS);
    prisma.$executeRaw`DELETE FROM "RateLimitHit" WHERE "at" < ${cutoff}`.catch((error: unknown) =>
      console.error("[rate-limit] cleanup failed", error),
    );
  }

  return result;
}

async function hit(key: string, config: RateLimitConfig, now: number): Promise<RateLimitResult> {
  return hitMany([{ key, config }], now);
}

export const postgresRateLimitStore: RateLimitStore = { hit, hitMany };
