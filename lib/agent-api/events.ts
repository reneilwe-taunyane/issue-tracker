import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeInbox } from "@/lib/agent-api/inbox";

/**
 * Agent event feed (#445).
 *
 * Agents poll `GET /api/v1/events?after=&afterId=&wait=` to learn what changed
 * inside their tenant. The cursor is `(txid, id)` on `AgentEvent` (#739):
 * `txid` is the id of the transaction that wrote the event, and a poll only
 * returns events whose transaction can no longer be running. `createdAt` is
 * set before commit, so ordering by it let an event that committed late land
 * behind a cursor that had already moved past it.
 *
 * Webhooks deliver the same event ids, so a client can dedupe across both
 * channels.
 */

export const EVENT_MAX_WAIT_SECONDS = 25;
export const EVENT_POLL_INTERVAL_MS = 500; // first check; later ones back off (#545)
export const EVENT_MAX_POLL_INTERVAL_MS = 4_000;

/**
 * Delay before the next long-poll query (#545). Starts at 500 ms so a waiter
 * still learns about a new event quickly, then doubles up to 4 s: a client
 * waiting the full 25 s makes ~8 queries instead of 50.
 */
export function nextPollDelayMs(attempt: number, maxMs = EVENT_MAX_POLL_INTERVAL_MS): number {
  if (!Number.isFinite(attempt) || attempt < 0) return EVENT_POLL_INTERVAL_MS;
  return Math.min(maxMs, EVENT_POLL_INTERVAL_MS * 2 ** Math.min(Math.floor(attempt), 10));
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Every event type `publish()` writes (#534). One source of truth: the doc's
 * event list and `event-types.test.ts` compare against this constant, so a new
 * publisher cannot drift from the documentation.
 */
export const AGENT_EVENT_TYPES = [
  "approval.granted",
  "approval.requested",
  "claim.accepted",
  "claim.extended",
  "claim.offered",
  "claim.released",
  "comment.created",
  "comment.deleted",
  "comment.edited",
  "github.merge_failed",
  "issue.accepted",
  "issue.bid",
  "issue.bid_awarded",
  "issue.bid_withdrawn",
  "issue.confirmed",
  "issue.created",
  "issue.deleted",
  "issue.interest",
  "issue.restored",
  "issue.structured",
  "issue.test_verdict",
  "issue.updated",
  "issue.validated",
  "job.created",
  "job.review.requested",
  "job.submission.reviewed",
  "question.answered",
  "question.asked",
  "redesign.proposed",
  "review.completed",
  "review.requested",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type EventPayload = Prisma.InputJsonObject;

/**
 * Writes one `AgentEvent` row. Call this inside the same transaction that
 * performs the domain change so the event commits atomically with it.
 *
 * Export contract: other issues call `publish()` to emit events into the feed.
 * This PR adds `issue.created` and `comment.created`.
 */
export async function publish(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    tenantId: string;
    type: string;
    payload: EventPayload;
    actorAgentId?: string | null;
    bugId?: string | null;
  },
): Promise<{ id: string }> {
  const event = await db.agentEvent.create({
    data: {
      tenantId: params.tenantId,
      type: params.type,
      payload: params.payload,
      actorAgentId: params.actorAgentId ?? null,
      bugId: params.bugId ?? null,
    },
    select: { id: true },
  });
  const subscriptions = await db.webhookSubscription.findMany({
    where: { enabled: true, agent: { tenantId: params.tenantId, revokedAt: null,
      owner: { memberships: { some: { tenantId: params.tenantId } } } },
      // Empty filter = every event; otherwise only the subscribed types (#512).
      OR: [{ events: { isEmpty: true } }, { events: { has: params.type } }] },
    select: { id: true },
  });
  if (subscriptions.length) await db.webhookDelivery.createMany({
    data: subscriptions.map(({ id }) => ({ subscriptionId: id, eventId: event.id, nextAttemptAt: new Date() })),
    skipDuplicates: true,
  });
  // #601: what this event addresses to one agent goes to its inbox too.
  await writeInbox(db, { id: event.id, ...params });
  return event;
}

// Make the type importable without importing Prisma everywhere.
type PrismaClient = typeof prisma;

// ---------------------------------------------------------------------------
// Poll cursor
// ---------------------------------------------------------------------------

/**
 * A position in the feed. Responses always hand out `{ txid, id }`. The
 * `{ createdAt, id }` form is what cursors issued before #739, and the manual
 * `after=<ISO>&afterId=` form, decode to; it still works as a starting point.
 */
export type EventCursor =
  | { txid: bigint; id: string }
  | { createdAt: Date; id: string };

/** Encode a cursor to an opaque string safe in query parameters. */
export function encodeEventCursor(cursor: EventCursor): string {
  const value = "txid" in cursor
    ? ["t", cursor.txid.toString(), cursor.id]
    : [cursor.createdAt.toISOString(), cursor.id];
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const PG_BIGINT_MIN = BigInt("-9223372036854775808");
const PG_BIGINT_MAX = BigInt("9223372036854775807");

/** Decode a cursor produced by `encodeEventCursor`. Returns `null` on invalid input. */
export function decodeEventCursor(raw: string | null | undefined): EventCursor | null {
  if (!raw || raw.length > 300) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value)) return null;
    if (value.length === 3 && value[0] === "t") {
      const [, txid, id] = value;
      if (typeof txid !== "string" || !/^-?\d{1,19}$/.test(txid) || typeof id !== "string" || !id.trim() || id.length > 191) return null;
      // 19 digits can still overflow Postgres bigint; Prisma would throw a 500.
      const parsed = BigInt(txid);
      if (parsed < PG_BIGINT_MIN || parsed > PG_BIGINT_MAX) return null;
      return { txid: parsed, id };
    }
    if (value.length !== 2) return null;
    const [iso, id] = value;
    if (typeof iso !== "string" || !z.iso.datetime({ offset: true }).safeParse(iso).success || typeof id !== "string" || !id.trim() || id.length > 191) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Parse `?after=<cursor>&afterId=<id>` from query params.
 *
 * Two forms are supported:
 * 1. `after=<base64url cursor>` — cursor from a previous response.
 * 2. `after=<ISO timestamp>&afterId=<id>` — explicit position (convenient for
 *    manual calls; id breaks ties when two events share a timestamp).
 *
 * Returns `null` when no cursor is present, or `"invalid"` when the cursor is
 * malformed so the caller can return a 400.
 */
export function parseEventCursor(
  params: URLSearchParams,
): EventCursor | null | "invalid" {
  const after = params.get("after");
  const afterId = params.get("afterId");

  if (after === null && afterId === null) return null;
  if (!after) return "invalid";

  // If afterId is provided, treat `after` as an ISO timestamp.
  if (afterId !== null) {
    const createdAt = new Date(after);
    if (!z.iso.datetime({ offset: true }).safeParse(after).success || !afterId.trim() || afterId.length > 191) return "invalid";
    return { createdAt, id: afterId };
  }

  // Otherwise try to decode it as a cursor blob.
  const cursor = decodeEventCursor(after);
  return cursor ?? "invalid";
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Optional narrowing of the feed (#602). The cursor stays global, so a
 * filtered poll can resume from (or hand over) the same cursor as an
 * unfiltered one.
 */
export type EventFilters = {
  /** Exact event types. */
  types?: string[];
  /** Type prefixes from `claim.*` entries, stored as `claim.`. */
  typePrefixes?: string[];
  projectId?: string;
  bugId?: string;
};

export type EventFilterError = { error: string; validTypes?: readonly string[] };

function validId(value: string): boolean {
  return value.trim() !== "" && value.length <= 191;
}

/**
 * Parse `?types=&projectId=&bugId=`. `types` is a comma list of event types
 * or `prefix.*` patterns; an unknown entry is an error that lists the valid
 * types so the caller can return a 400.
 */
export function parseEventFilters(params: URLSearchParams): EventFilters | EventFilterError {
  const filters: EventFilters = {};

  const typesRaw = params.get("types");
  if (typesRaw !== null) {
    const entries = [...new Set(typesRaw.split(",").map((t) => t.trim()).filter(Boolean))];
    if (!entries.length) return { error: "types must list at least one event type.", validTypes: AGENT_EVENT_TYPES };
    const known = new Set<string>(AGENT_EVENT_TYPES);
    const types: string[] = [];
    const typePrefixes: string[] = [];
    const unknown: string[] = [];
    for (const entry of entries) {
      if (known.has(entry)) types.push(entry);
      else if (entry.endsWith(".*") && entry.length > 2 && AGENT_EVENT_TYPES.some((t) => t.startsWith(entry.slice(0, -1)))) {
        typePrefixes.push(entry.slice(0, -1));
      } else unknown.push(entry);
    }
    if (unknown.length) {
      return { error: `Unknown event type: ${unknown.slice(0, 10).join(", ").slice(0, 300)}.`, validTypes: AGENT_EVENT_TYPES };
    }
    if (types.length) filters.types = types;
    if (typePrefixes.length) filters.typePrefixes = typePrefixes;
  }

  for (const key of ["projectId", "bugId"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!validId(value)) return { error: `Invalid ${key}.` };
    filters[key] = value;
  }

  return filters;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const eventSelect = {
  id: true,
  type: true,
  payload: true,
  actorAgentId: true,
  bugId: true,
  createdAt: true,
  txid: true,
} satisfies Prisma.AgentEventSelect;

export type AgentEventRow = {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  actorAgentId: string | null;
  bugId: string | null;
  createdAt: Date;
  txid: bigint;
};

/**
 * The oldest transaction id that may still be running (#739). Every
 * transaction below it has committed or rolled back, so an event with a
 * smaller `txid` is either visible now or never will be. A later poll can only
 * reveal events with a `txid` at or above this, which is past any cursor
 * handed out now.
 */
async function settledBefore(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ xmin: string }[]>`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`;
  return BigInt(row.xmin);
}

function afterCursor(cursor: EventCursor): Prisma.AgentEventWhereInput {
  if ("txid" in cursor) {
    return {
      OR: [
        { txid: { gt: cursor.txid } },
        { txid: cursor.txid, id: { gt: cursor.id } },
      ],
    };
  }
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * Fetch events for `agent.tenantId` that come after `cursor`, in ascending
 * order (oldest first). Reads 101 rows so the route can detect another page.
 * Events from transactions that may still be running are held back until
 * they settle, so a cursor never moves past an event that is about to appear.
 * `filters` narrow the result; the `(tenantId, projectId|bugId, txid, id)`
 * indexes keep project and issue polls off the tenant-wide scan (#602).
 */
export async function listEvents(
  agent: Pick<AgentContext, "tenantId">,
  cursor: EventCursor | null,
  filters: EventFilters = {},
): Promise<AgentEventRow[]> {
  const typeMatches: Prisma.AgentEventWhereInput[] = [
    ...(filters.types?.length ? [{ type: { in: filters.types } }] : []),
    ...(filters.typePrefixes ?? []).map((prefix) => ({ type: { startsWith: prefix } })),
  ];
  const where: Prisma.AgentEventWhereInput = {
    tenantId: agent.tenantId,
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.bugId ? { bugId: filters.bugId } : {}),
    ...(typeMatches.length ? { AND: [typeMatches.length === 1 ? typeMatches[0]! : { OR: typeMatches }] } : {}),
    txid: { lt: await settledBefore() },
    ...(cursor ? afterCursor(cursor) : {}),
  };
  return prisma.agentEvent.findMany({
    where,
    orderBy: [{ txid: "asc" }, { id: "asc" }],
    take: 101,
    select: eventSelect,
  });
}

/**
 * Long-poll implementation: wait up to `waitSeconds` for at least one new
 * event after `cursor`, polling the DB every `pollIntervalMs` ms.
 *
 * Returns immediately when events are already available.
 */
export async function pollEvents(
  agent: Pick<AgentContext, "tenantId">,
  cursor: EventCursor | null,
  waitSeconds: number,
  filters: EventFilters = {},
  pollIntervalMs = EVENT_POLL_INTERVAL_MS,
): Promise<AgentEventRow[]> {
  const wait = Number.isFinite(waitSeconds) ? Math.max(0, Math.min(waitSeconds, EVENT_MAX_WAIT_SECONDS)) : 0;
  const deadline = Date.now() + wait * 1000;

  for (let attempt = 0; ; attempt += 1) {
    const rows = await listEvents(agent, cursor, filters);
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    // Sleep for one interval, but don't overshoot the deadline.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return rows;
    const delay = pollIntervalMs === EVENT_POLL_INTERVAL_MS
      ? nextPollDelayMs(attempt)
      : pollIntervalMs;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
  }
}
