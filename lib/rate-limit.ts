import { createHash } from "node:crypto";

export const RATE_LIMIT_MESSAGE =
  "You're doing that too fast. Please wait a moment.";

export type RateLimitConfig = {
  max: number;
  windowMs: number;
};

export const ACTION_RATE_LIMITS = {
  createBug: { max: 10, windowMs: 60 * 1000 },
  addComment: { max: 20, windowMs: 60 * 1000 },
  toggleVote: { max: 60, windowMs: 60 * 1000 },
  editBug: { max: 20, windowMs: 60 * 1000 },
  editComment: { max: 30, windowMs: 60 * 1000 },
  selfAssign: { max: 15, windowMs: 60 * 1000 },
} as const;

const MINUTE = 60 * 1000;

/**
 * Limits for the sign-in, sign-up and password-reset actions (#207). Each is
 * checked twice, per email address and per client IP, so one attacker can't
 * hammer one account and can't spray many accounts from one address.
 */
export const AUTH_RATE_LIMITS = {
  login: { email: { max: 10, windowMs: 15 * MINUTE }, ip: { max: 30, windowMs: 15 * MINUTE } },
  signup: { email: { max: 3, windowMs: 60 * MINUTE }, ip: { max: 10, windowMs: 60 * MINUTE } },
  forgotPassword: { email: { max: 3, windowMs: 15 * MINUTE }, ip: { max: 10, windowMs: 15 * MINUTE } },
  resetPassword: { email: { max: 10, windowMs: 15 * MINUTE }, ip: { max: 20, windowMs: 15 * MINUTE } },
} as const;

export type AuthRateLimitAction = keyof typeof AUTH_RATE_LIMITS;

const tracker = new Map<string, number[]>();

/** Bound memory use: past this many keys, drop the ones whose window has passed. */
const MAX_TRACKED_KEYS = 10_000;
const LONGEST_WINDOW_MS = 60 * MINUTE;

function pruneExpired(now: number) {
  for (const [key, timestamps] of tracker) {
    const latest = timestamps[timestamps.length - 1] ?? 0;
    if (latest <= now - LONGEST_WINDOW_MS) tracker.delete(key);
  }
}

/**
 * Sliding window rate limiter for user actions.
 * Automatically evicts timestamps older than windowMs.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
  now = Date.now(),
): RateLimitResult {
  const windowStart = now - config.windowMs;
  const timestamps = (tracker.get(key) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= config.max) {
    const oldest = timestamps[0] ?? now;
    const retryAfterMs = Math.max(0, oldest + config.windowMs - now);
    return { allowed: false, retryAfterMs, remaining: 0, resetAfterMs: retryAfterMs };
  }

  timestamps.push(now);
  tracker.set(key, timestamps);
  if (tracker.size > MAX_TRACKED_KEYS) pruneExpired(now);
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: config.max - timestamps.length,
    resetAfterMs: Math.max(0, (timestamps[0] ?? now) + config.windowMs - now),
  };
}

export type RateLimitItem = {
  key: string;
  config: RateLimitConfig;
};

/**
 * Sliding window rate limiter for multiple items atomically.
 * Only records attempts if all items are within their limits.
 */
export function checkManyRateLimits(
  items: RateLimitItem[],
  now = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  if (items.length === 0) return { allowed: true, retryAfterMs: 0 };

  const blocked: RateLimitResult[] = [];
  const keyCounts = new Map<string, number>();
  for (const { key } of items) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  for (const { key, config } of items) {
    const windowStart = now - config.windowMs;
    const timestamps = (tracker.get(key) ?? []).filter((t) => t > windowStart);
    const needed = keyCounts.get(key) ?? 1;
    if (timestamps.length + needed - 1 >= config.max) {
      const oldest = timestamps[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + config.windowMs - now);
      blocked.push({ allowed: false, retryAfterMs });
    }
  }

  if (blocked.length > 0) {
    return {
      allowed: false,
      retryAfterMs: Math.max(...blocked.map((c) => c.retryAfterMs)),
    };
  }

  for (const { key, config } of items) {
    const windowStart = now - config.windowMs;
    const timestamps = (tracker.get(key) ?? []).filter((t) => t > windowStart);
    timestamps.push(now);
    tracker.set(key, timestamps);
  }
  if (tracker.size > MAX_TRACKED_KEYS) pruneExpired(now);

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Checks an auth action against both its per-email and per-IP limits (#207).
 * Either limit being hit blocks the attempt.
 */
export function checkAuthRateLimit(
  action: AuthRateLimitAction,
  { email, ip }: { email?: string | null; ip?: string | null },
  now = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  const limits = AUTH_RATE_LIMITS[action];
  const items: RateLimitItem[] = [];
  if (email) {
    items.push({
      key: `auth:${action}:email:${email.trim().toLowerCase()}`,
      config: limits.email,
    });
  }
  if (ip) {
    items.push({
      key: `auth:${action}:ip:${ip}`,
      config: limits.ip,
    });
  }
  return checkManyRateLimits(items, now);
}

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

function validIp(value: string | null | undefined): string | null {
  const ip = value?.trim() ?? "";
  return IP_PATTERN.test(ip) ? ip : null;
}

/**
 * How many proxies in front of the app append to `X-Forwarded-For` (#507).
 * Traefik (Coolify) and Vercel each add exactly one hop, so the default is 1.
 * 0 means there is no proxy and forwarding headers are not trusted at all.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number.parseInt(raw, 10);
  return Number.isFinite(hops) && hops >= 0 ? Math.min(hops, 10) : 1;
}

/**
 * Comma-separated list of trusted proxy IPs or CIDR subnets (#675).
 * When specified, X-Forwarded-For is parsed from right to left across trusted proxies,
 * selecting the first untrusted IP in the chain as the client IP.
 */
export function trustedProxies(): string[] {
  const raw = process.env.TRUSTED_PROXIES?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function matchesCidr(ip: string, cidr: string): boolean {
  const [net, maskStr] = cidr.split("/");
  if (!maskStr) return ip.toLowerCase() === net.toLowerCase();
  const mask = Number.parseInt(maskStr, 10);
  if (!Number.isFinite(mask) || mask < 0 || mask > 32) return false;

  const ipParts = ip.split(".").map(Number);
  const netParts = net.split(".").map(Number);
  if (ipParts.length !== 4 || netParts.length !== 4 || ipParts.some(Number.isNaN) || netParts.some(Number.isNaN)) {
    return false;
  }

  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const netNum = ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
  const maskNum = mask === 0 ? 0 : ((-1 << (32 - mask)) >>> 0);

  return (ipNum & maskNum) === (netNum & maskNum);
}

export function isTrustedProxyIp(ip: string, list: string[]): boolean {
  const lowerIp = ip.toLowerCase();
  for (const entry of list) {
    const lowerEntry = entry.toLowerCase();
    if (lowerEntry === "loopback" && (lowerIp === "127.0.0.1" || lowerIp === "::1")) return true;
    if (lowerEntry === lowerIp) return true;
    if (lowerEntry.includes("/") && matchesCidr(lowerIp, lowerEntry)) return true;
  }
  return false;
}

/**
 * The client IP as seen by the proxy we trust, for rate-limit keys (#507, #675).
 *
 * When TRUSTED_PROXIES is configured, the X-Forwarded-For chain is evaluated from
 * right to left, stripping off verified intermediate proxies to uncover the genuine
 * client IP and prevent spoofing.
 *
 * Otherwise, the left-most `X-Forwarded-For` entry is whatever the client sent, so it
 * can't be trusted: rotating it would hand out a fresh bucket per request.
 * Each trusted proxy appends the address it received the request from, so
 * the client is the entry `TRUSTED_PROXY_HOPS` places from the right.
 * `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) overrides this when the
 * platform sets a single header the client can't forge.
 */
export type HeadersLike = { get(name: string): string | null };
export type RequestWithHeadersAndIp = {
  headers: HeadersLike;
  ip?: string | null;
  socket?: { remoteAddress?: string | null };
};

/**
 * The client IP as seen by the proxy we trust, for rate-limit keys (#507, #663, #675).
 *
 * When TRUSTED_PROXIES is configured, the connection IP is verified first:
 * - If connection IP is from an untrusted client (not in TRUSTED_PROXIES),
 *   X-Forwarded-For is ignored (spoofed) and the connection IP is returned.
 * - If connection IP is from a trusted proxy, the X-Forwarded-For chain is evaluated
 *   from right to left, stripping verified intermediate proxies to uncover the genuine
 *   client IP.
 * - Falls back to connection IP when all forwarded IPs are trusted or absent.
 *
 * Otherwise, the left-most `X-Forwarded-For` entry is whatever the client sent, so it
 * can't be trusted: rotating it would hand out a fresh bucket per request.
 * Each trusted proxy appends the address it received the request from, so
 * the client is the entry `TRUSTED_PROXY_HOPS` places from the right.
 * `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) overrides this when the
 * platform sets a single header the client can't forge.
 */
export function clientIpFrom(
  headersOrRequest: HeadersLike | RequestWithHeadersAndIp,
  connectionIp?: string | null,
): string | null {
  const headers = "headers" in headersOrRequest ? headersOrRequest.headers : headersOrRequest;
  const directIp = validIp(
    connectionIp ??
      ("ip" in headersOrRequest
        ? headersOrRequest.ip
        : "socket" in headersOrRequest
          ? headersOrRequest.socket?.remoteAddress
          : undefined),
  );

  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configured) return validIp(headers.get(configured)?.split(",")[0]) ?? directIp;

  const proxyList = trustedProxies();
  if (proxyList.length > 0) {
    // If we have a direct connection IP from an untrusted source, do NOT trust
    // headers sent by the client; return the connection IP directly (#663).
    if (directIp && !isTrustedProxyIp(directIp, proxyList)) {
      return directIp;
    }

    const chain = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const candidate = validIp(chain[i]);
        if (!candidate) continue;
        if (!isTrustedProxyIp(candidate, proxyList)) {
          return candidate;
        }
      }
      return directIp;
    }
    return validIp(headers.get("x-real-ip")) ?? directIp;
  }

  const hops = trustedProxyHops();
  if (hops === 0) return directIp;

  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length > 0) {
    const candidate = validIp(chain[Math.max(0, chain.length - hops)]);
    return candidate ?? directIp;
  }
  return validIp(headers.get("x-real-ip")) ?? directIp;
}

let warnedNoClientIp = false;

/**
 * A rate-limit key for one client (#509, #663). With no usable IP, every caller
 * used to share one "unknown" bucket, so a single client could lock everyone
 * else out. Those callers now get a bucket per browser/agent fingerprint
 * instead, and production logs once so the missing proxy header gets fixed.
 */
export function clientRateLimitKey(
  headersOrRequest: HeadersLike | RequestWithHeadersAndIp,
  connectionIp?: string | null,
): string {
  const ip = clientIpFrom(headersOrRequest, connectionIp);
  if (ip) return `ip:${ip}`;
  const headers = "headers" in headersOrRequest ? headersOrRequest.headers : headersOrRequest;
  if (!warnedNoClientIp && process.env.NODE_ENV === "production") {
    warnedNoClientIp = true;
    console.warn(
      "[rate-limit] no client IP on a request; check that the proxy sets X-Forwarded-For or set CLIENT_IP_HEADER",
    );
  }
  const fingerprint = [headers.get("user-agent") ?? "", headers.get("accept-language") ?? ""].join("|");
  return `anon:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Shared store (#296)
//
// The functions above keep their window in this process's memory, so with
// several instances each one has its own counters and a deploy resets them
// all. The async functions below use a store shared by every instance — a
// Postgres table — and fall back to the in-memory limiter if that store
// fails, so an outage degrades to per-instance limits, never to blocking
// everyone and never to no limit at all.
// ---------------------------------------------------------------------------

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
  /**
   * Attempts left in the window after this one (#646). Computed from the
   * same read the check already does, so reporting it costs nothing extra.
   * Optional: stores and test doubles that don't know it leave it out.
   */
  remaining?: number;
  /** When the oldest counted attempt leaves the window, in ms from now (#646). */
  resetAfterMs?: number;
};

export type RateLimitStore = {
  hit(key: string, config: RateLimitConfig, now: number): Promise<RateLimitResult>;
  hitMany?(items: RateLimitItem[], now: number): Promise<RateLimitResult>;
};

export type RateLimitStoreName = "postgres" | "memory";

/**
 * `RATE_LIMIT_STORE=postgres|memory`. Unset: Postgres in production, memory
 * everywhere else (dev, tests), so local work and the existing tests don't
 * need the table.
 */
export function rateLimitStoreName(
  env: { RATE_LIMIT_STORE?: string; NODE_ENV?: string } = process.env,
): RateLimitStoreName {
  const chosen = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (chosen === "postgres" || chosen === "memory") return chosen;
  return env.NODE_ENV === "production" ? "postgres" : "memory";
}

const memoryStore: RateLimitStore = {
  hit: async (key, config, now) => checkRateLimit(key, config, now),
  hitMany: async (items, now) => checkManyRateLimits(items, now),
};

let storeOverride: RateLimitStore | null = null;

/** Replace the store (tests). Pass null to go back to the configured one. */
export function setRateLimitStore(store: RateLimitStore | null): void {
  storeOverride = store;
}

async function configuredStore(): Promise<RateLimitStore> {
  if (storeOverride) return storeOverride;
  if (rateLimitStoreName() === "memory") return memoryStore;
  // Loaded lazily so code and tests that only use the in-memory limiter
  // never import Prisma.
  const { postgresRateLimitStore } = await import("./rate-limit-postgres");
  return postgresRateLimitStore;
}

let lastStoreErrorAt: number | null = null;

/**
 * Records one attempt against `key` in the shared store and says whether
 * it's allowed. If the store fails, the in-memory limiter answers instead.
 */
export async function consumeRateLimit(
  key: string,
  config: RateLimitConfig,
  now = Date.now(),
): Promise<RateLimitResult> {
  const store = await configuredStore();
  if (store === memoryStore) return checkRateLimit(key, config, now);
  try {
    const result = await store.hit(key, config, now);
    if (typeof result?.allowed !== "boolean") throw new Error("rate-limit store returned no result");
    return result;
  } catch (error) {
    // Once a minute is enough to notice; every request would flood the log.
    if (lastStoreErrorAt === null || now - lastStoreErrorAt > MINUTE) {
      lastStoreErrorAt = now;
      console.error("[rate-limit] shared store failed; using this instance's memory", error);
    }
    return checkRateLimit(key, config, now);
  }
}

async function fallbackHitMany(
  store: RateLimitStore,
  items: RateLimitItem[],
  now: number,
): Promise<RateLimitResult> {
  const checks = await Promise.all(items.map((item) => store.hit(item.key, item.config, now)));
  const blocked = checks.filter((c) => !c.allowed);
  if (blocked.length === 0) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(...blocked.map((c) => c.retryAfterMs)) };
}

/**
 * Records attempts against multiple keys in the shared store atomically and
 * says whether all are allowed (#678). If the store fails, the in-memory limiter answers instead.
 */
export async function consumeRateLimits(
  items: RateLimitItem[],
  now = Date.now(),
): Promise<RateLimitResult> {
  if (items.length === 0) return { allowed: true, retryAfterMs: 0 };
  const store = await configuredStore();
  if (store === memoryStore) return checkManyRateLimits(items, now);
  try {
    const result = store.hitMany
      ? await store.hitMany(items, now)
      : await fallbackHitMany(store, items, now);
    if (typeof result?.allowed !== "boolean") throw new Error("rate-limit store returned no result");
    return result;
  } catch (error) {
    if (lastStoreErrorAt === null || now - lastStoreErrorAt > MINUTE) {
      lastStoreErrorAt = now;
      console.error("[rate-limit] shared store failed; using this instance's memory", error);
    }
    return checkManyRateLimits(items, now);
  }
}

/** `checkAuthRateLimit`, against the shared store (#678). */
export async function consumeAuthRateLimit(
  action: AuthRateLimitAction,
  { email, ip }: { email?: string | null; ip?: string | null },
  now = Date.now(),
): Promise<RateLimitResult> {
  const limits = AUTH_RATE_LIMITS[action];
  const items: RateLimitItem[] = [];
  if (email) {
    items.push({
      key: `auth:${action}:email:${email.trim().toLowerCase()}`,
      config: limits.email,
    });
  }
  if (ip) {
    items.push({
      key: `auth:${action}:ip:${ip}`,
      config: limits.ip,
    });
  }
  return consumeRateLimits(items, now);
}

/** The longest window any limit uses; shared-store rows older than this are dead. */
export const RATE_LIMIT_RETENTION_MS = LONGEST_WINDOW_MS;

/** Number of keys currently tracked (for tests). */
export function trackedKeyCount(): number {
  return tracker.size;
}

/** Reset rate limit tracker (useful for testing). */
export function resetRateLimits(): void {
  tracker.clear();
  lastStoreErrorAt = null;
}
