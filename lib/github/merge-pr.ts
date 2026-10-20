import { createSign } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { notifyMergeFailed } from "@/lib/agent-notifications";
import { checkApprovalOpen } from "@/lib/approvals";

/**
 * Merging the linked pull request after the tracker accepts a fix (#452).
 *
 * #434 records the acceptance on Ziki; it does not merge git. This module
 * merges the linked pull request through a GitHub App installation on the
 * project (`Project.githubInstallationId`) — never a personal access token.
 * Installation tokens are minted when needed and kept in memory only; nothing
 * is written to the database.
 *
 * The merge is attempted only when all of the gates hold: #434 accepted the
 * fix, the issue links a pull request that belongs to `Project.repoUrl`, the
 * pull request's checks are green, and the app can merge that repo. On failure
 * the tracker acceptance is left untouched, a `github.merge_failed` event is
 * published, and the claim's person is notified.
 */

// ---------------------------------------------------------------------------
// URL parsing (pure)
// ---------------------------------------------------------------------------

export type RepoRef = { owner: string; repo: string };
export type PullRequestRef = RepoRef & { number: number };

const GITHUB_HOST = "github.com";

/** Parse `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo`. */
export function parseGitHubRepoUrl(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const trimmed = url.trim();
  const scp = /^[^@\s]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Parse `https://github.com/owner/repo/pull/123` (trailing path ignored). */
export function parsePullRequestUrl(url: string | null | undefined): PullRequestRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** True when two refs name the same repository (GitHub is case-insensitive). */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

// ---------------------------------------------------------------------------
// The GitHub client (real one, and the seam tests fake)
// ---------------------------------------------------------------------------

export type PullRequest = { merged: boolean; mergeable: boolean; headSha: string };

/** What GitHub answered the merge request (#492). */
export type MergePullResult = {
  merged: boolean;
  sha?: string;
  forbidden?: boolean;
  /** GitHub refused because the head moved since the checks were read. */
  conflict?: boolean;
  /** The repository allows no merge method the app can use. */
  noAllowedMethod?: boolean;
};

export interface GitHubClient {
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  checksGreen(ref: PullRequestRef, headSha: string): Promise<boolean>;
  /** Merge `ref` pinned to `headSha`, the commit whose checks were verified. */
  mergePullRequest(ref: PullRequestRef, headSha: string): Promise<MergePullResult>;
  getPullRequestFiles?(ref: PullRequestRef): Promise<string[]>;
}

export class GitHubError extends Error {}

const GITHUB_API = "https://api.github.com";

/** base64url encode, the JWT segment encoding. */
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign the short-lived app JWT GitHub wants when minting an installation
 * token: RS256, `iss` is the app id, and it may live at most 10 minutes.
 */
export function createAppJwt(appId: string, privateKey: string, now: number = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(now / 1000) - 60;
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * A client for one installation. The installation token is minted on first use
 * and cached in memory for the life of the client; it is never persisted.
 */
export function createInstallationClient(
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): GitHubClient {
  let token: string | null = null;

  async function installationToken(): Promise<string> {
    if (token) return token;
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) throw new GitHubError("The GitHub App is not configured.");
    const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
        accept: "application/vnd.github+json",
        "user-agent": "ziki-issues",
      },
    });
    if (!response.ok) throw new GitHubError("Could not mint an installation token.");
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new GitHubError("GitHub returned no installation token.");
    token = body.token;
    return token;
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const value = await installationToken();
    return fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${value}`,
        accept: "application/vnd.github+json",
        "user-agent": "ziki-issues",
        ...(init?.headers ?? {}),
      },
    });
  }

  return {
    async getPullRequest(ref) {
      const response = await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
      if (!response.ok) throw new GitHubError("Could not read the pull request.");
      const body = (await response.json()) as {
        merged?: boolean;
        mergeable?: boolean;
        head?: { sha?: string };
      };
      return { merged: !!body.merged, mergeable: body.mergeable !== false, headSha: body.head?.sha ?? "" };
    },
    async checksGreen(ref, headSha) {
      // Every check run on the head commit has to be read (#491). GitHub
      // pages check runs 30 at a time by default; a failing run past the
      // first page used to stay invisible while the gate passed.
      const runs: { status?: string; conclusion?: string | null }[] = [];
      for (let page = 1; ; page += 1) {
        const response = await request(
          `/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
        );
        if (!response.ok) break;
        const body = (await response.json()) as {
          check_runs?: { status?: string; conclusion?: string | null }[];
          total_count?: number;
        };
        const batch = body.check_runs ?? [];
        runs.push(...batch);
        if (batch.length < 100 || runs.length >= (body.total_count ?? runs.length)) break;
      }
      if (runs.length) {
        // Fail closed (#491): anything still queued or in progress, failed or
        // cancelled, is not green. Only completed runs with a passing
        // conclusion pass.
        return runs.every(
          (run) =>
            run.status === "completed" &&
            (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped"),
        );
      }
      // No check runs: fall back to commit statuses. No statuses at all means
      // the repository has no required checks, so the gate holds. A "pending"
      // state while statuses exist means a check is still running — that is
      // not green (#491).
      const status = await request(`/repos/${ref.owner}/${ref.repo}/commits/${headSha}/status`);
      if (!status.ok) return false;
      const body = (await status.json()) as { state?: string; statuses?: unknown[] };
      const statuses = body.statuses ?? [];
      if (!statuses.length && (body.state === undefined || body.state === "pending")) return true;
      return body.state === "success";
    },
    async mergePullRequest(ref, headSha) {
      // Squash is not universally allowed (#492): ask the repository which
      // methods it accepts and prefer squash, then a merge commit, then
      // rebase. If the settings can't be read, keep the old squash default.
      let method: string | null = "squash";
      const repo = await request(`/repos/${ref.owner}/${ref.repo}`);
      if (repo.ok) {
        const body = (await repo.json()) as {
          allow_squash_merge?: boolean;
          allow_merge_commit?: boolean;
          allow_rebase_merge?: boolean;
        };
        method = body.allow_squash_merge
          ? "squash"
          : body.allow_merge_commit
            ? "merge"
            : body.allow_rebase_merge
              ? "rebase"
              : null;
      }
      if (!method) return { merged: false, noAllowedMethod: true };
      // Pinning `sha` (#492): GitHub then refuses with 409 when the head has
      // moved since the checks were read, so unreviewed commits never merge.
      const response = await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method, sha: headSha }),
      });
      if (response.status === 403) return { merged: false, forbidden: true };
      if (response.status === 405) return { merged: false, noAllowedMethod: true };
      if (response.status === 409) return { merged: false, conflict: true };
      if (!response.ok) return { merged: false };
      const body = (await response.json()) as { merged?: boolean; sha?: string };
      return { merged: !!body.merged, sha: body.sha };
    },
  };
}

function clientFor(installationId: string | null | undefined, env?: NodeJS.ProcessEnv): GitHubClient | null {
  if (!installationId) return null;
  try {
    return createInstallationClient(installationId, env);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The gated merge
// ---------------------------------------------------------------------------

export type MergeFailureReason =
  | "not_found"
  | "not_accepted"
  | "no_pull_request"
  | "repo_mismatch"
  | "checks_failed"
  | "head_moved"
  | "no_permission"
  | "merge_failed"
  | "waiting_for_human";

export type MergeResult =
  | { status: 200; merged: true; mergeCommitSha: string; pullRequestUrl: string }
  | { status: 403 | 404 | 409 | 422; merged: false; reason: MergeFailureReason; message: string; approvalId?: string };

export type MergeDeps = {
  /** Injected in tests; the real client is built from the project's installation. */
  client?: GitHubClient;
  db?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  files?: string[];
};

const mergeBugSelect = {
  id: true,
  title: true,
  tenantId: true,
  pullRequestUrl: true,
  assigneeId: true,
  project: { select: { repoUrl: true, githubInstallationId: true } },
  claims: {
    where: { status: "active", releasedAt: null },
    select: { beneficiaryUserId: true },
    take: 1,
  },
} as const;

type LoadedBug = {
  id: string;
  title: string;
  tenantId: string;
  pullRequestUrl: string | null;
  assigneeId: string | null;
  project: { repoUrl: string | null; githubInstallationId: string | null } | null;
  claims: { beneficiaryUserId: string }[];
};

function fail(
  status: 403 | 404 | 409 | 422,
  reason: MergeFailureReason,
  message: string,
): MergeResult {
  return { status, merged: false, reason, message };
}

/**
 * Publish `github.merge_failed`, record it, and tell the claim's person. The
 * tracker acceptance (`status`, points) is never touched here.
 */
async function recordMergeFailure(
  agent: AgentContext,
  bug: LoadedBug,
  reason: string,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "github.merge_failed",
      payload: { issueId: bug.id, reason, pullRequestUrl: bug.pullRequestUrl },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
    await audit(agent, "github.merge_failed", `bug:${bug.id}`, { reason }, { bugId: bug.id, db: tx });
  });
  const recipient = bug.claims[0]?.beneficiaryUserId ?? bug.assigneeId ?? null;
  if (recipient) {
    notifyMergeFailed({
      bugId: bug.id,
      bugTitle: bug.title,
      recipientId: recipient,
      reason,
      agent: { name: agent.name },
    });
  }
}

/**
 * The `issue.accepted` audit row that still stands for an issue (#490).
 *
 * Acceptance lives on the audit row rather than on `Bug.status`, so this is
 * the single test for "a merger accepted this fix". A tenant admin undo
 * (#450) stamps `undoneAt`; an undone acceptance must not gate anything.
 */
export async function standingAcceptance(
  db: PrismaClient,
  bugId: string,
): Promise<{ id: string } | null> {
  return db.agentAuditEvent.findFirst({
    where: { bugId, action: "issue.accepted", undoneAt: null },
    select: { id: true },
  });
}

/**
 * Merge the accepted fix's linked pull request (#452). See the module comment
 * for the gates. Success records the merge commit sha on the `github.merged`
 * audit event and returns it.
 */
export async function mergeAcceptedFix(
  agent: AgentContext,
  bugId: string,
  deps: MergeDeps = {},
): Promise<MergeResult> {
  const db = deps.db ?? prisma;

  const bug = (await db.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, isDeleted: false },
    select: mergeBugSelect,
  })) as LoadedBug | null;
  if (!bug) return fail(404, "not_found", "No such issue in this agent's tenant.");

  // Gate 1: #434 accepted the fix. Gate on its audit row, not on `status`,
  // which a person can also set by resolving the issue. A tenant admin's undo
  // (#450) stamps `undoneAt` on that row; an undone acceptance gates nothing.
  const accepted = await standingAcceptance(db, bug.id);
  if (!accepted) {
    return fail(409, "not_accepted", "The fix has not been accepted on the tracker yet.");
  }

  // Gate 2: the issue links a pull request that belongs to the project's repo.
  const ref = parsePullRequestUrl(bug.pullRequestUrl);
  if (!ref) return fail(409, "no_pull_request", "No pull request is linked to this issue.");
  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (!repo || !sameRepo(ref, repo)) {
    return fail(422, "repo_mismatch", "That pull request is not in this project's repository.");
  }

  const client = deps.client ?? clientFor(bug.project?.githubInstallationId, deps.env);
  let prFiles = deps.files ?? [];
  if (!prFiles.length && client?.getPullRequestFiles) {
    try {
      prFiles = await client.getPullRequestFiles(ref);
    } catch {
      // Non-fatal if files cannot be read
    }
  }

  const approvalCheck = await checkApprovalOpen(bug.id, "before_merge", {
    db: db as never,
    files: prFiles,
    agent,
  });
  if (!approvalCheck.allowed) {
    return {
      status: 409,
      merged: false,
      reason: "waiting_for_human",
      approvalId: approvalCheck.approvalId,
      message: "Human approval required before merge.",
    };
  }
  if (!client) {
    await recordMergeFailure(agent, bug, "The app is not installed on this repository.", db);
    return fail(403, "no_permission", "The app is not allowed to merge this repository.");
  }

  let pullRequest: PullRequest;
  try {
    pullRequest = await client.getPullRequest(ref);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached.", db);
    return fail(409, "merge_failed", "GitHub could not be reached.");
  }

  // Gate 3: the pull request's required checks are green.
  let green: boolean;
  try {
    green = await client.checksGreen(ref, pullRequest.headSha);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached.", db);
    return fail(409, "merge_failed", "GitHub could not be reached.");
  }
  if (!green) {
    await recordMergeFailure(agent, bug, "The pull request's checks are not green.", db);
    return fail(409, "checks_failed", "The pull request's required checks are not green.");
  }

  // Gate 4: the app has permission to merge that repo. The merge is pinned to
  // the head SHA whose checks were verified (#492).
  let merged: MergePullResult;
  try {
    merged = await client.mergePullRequest(ref, pullRequest.headSha);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached.", db);
    return fail(409, "merge_failed", "GitHub could not be reached.");
  }
  if (merged.forbidden) {
    await recordMergeFailure(agent, bug, "The app is not allowed to merge this repository.", db);
    return fail(403, "no_permission", "The app is not allowed to merge this repository.");
  }
  if (merged.conflict) {
    await recordMergeFailure(agent, bug, "The pull request changed after its checks were verified.", db);
    return fail(
      409,
      "head_moved",
      "The pull request's head commit changed since its checks were verified — link it again and verify the new commits.",
    );
  }
  if (merged.noAllowedMethod) {
    await recordMergeFailure(agent, bug, "The repository allows no merge method the app can use.", db);
    return fail(
      422,
      "merge_failed",
      "This repository allows no merge method the app can use. Enable squash, merge or rebase merges for it on GitHub.",
    );
  }
  if (!merged.merged) {
    await recordMergeFailure(agent, bug, "GitHub refused the merge.", db);
    return fail(409, "merge_failed", "GitHub refused the merge.");
  }

  const mergeCommitSha = merged.sha ?? pullRequest.headSha;
  await audit(
    agent,
    "github.merged",
    `bug:${bug.id}`,
    { mergeCommitSha, pullRequestUrl: bug.pullRequestUrl },
    { bugId: bug.id, db },
  );
  return {
    status: 200,
    merged: true,
    mergeCommitSha,
    pullRequestUrl: bug.pullRequestUrl ?? "",
  };
}
