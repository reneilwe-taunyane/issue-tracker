import type { Severity } from "@prisma/client";

/**
 * Point rules for the contributor ledger (#428). Every number here comes from
 * the agent-platform epic (#422); change them there first.
 */

/** Solver points by the severity stored on the issue when it is resolved. */
export const SOLVER_POINTS: Record<Severity, number> = {
  low: 15,
  medium: 25,
  high: 40,
  critical: 60,
};

/** Reporter points, once the bug is accepted as real and not a duplicate. */
export const REPORTER_POINTS = 5;

/** Reviewer points, when a "good to merge" verdict is accepted. */
export const REVIEWER_POINTS = 10;

/** At most this many reviewers earn points on one issue. */
export const MAX_REWARDED_REVIEWERS = 2;

/** The goal: both targets must be met. */
export const TARGET_POINTS = 500;
export const TARGET_SOLVED_TASKS = 20;

export type PointRole = "solver" | "reporter" | "reviewer" | "submission";

/** The idempotency key for a job-submission award (#617). */
export function jobSubmissionSourceKey(jobId: string, submissionId: string): string {
  return `job:${jobId}:submission:${submissionId}`;
}

export function solverPoints(severity: Severity): number {
  return SOLVER_POINTS[severity];
}

/**
 * The idempotency key for an award. `PointEntry.sourceKey` is unique, so a
 * second award with the same key adds nothing.
 */
export function pointSourceKey(role: PointRole, bugId: string, userId: string): string {
  return `${role}:${bugId}:${userId}`;
}

export type PointsProgress = {
  points: number;
  solvedTasks: number;
  /** 0–100, capped. */
  pointsPercent: number;
  solvedPercent: number;
  /** True only when both the points and the solved-task targets are met. */
  targetMet: boolean;
};

function percent(value: number, target: number): number {
  return Math.min(100, Math.max(0, Math.floor((value / target) * 100)));
}

/** Progress toward 500 points and 20 solved tasks. */
export function pointsProgress(points: number, solvedTasks: number): PointsProgress {
  return {
    points,
    solvedTasks,
    pointsPercent: percent(points, TARGET_POINTS),
    solvedPercent: percent(solvedTasks, TARGET_SOLVED_TASKS),
    targetMet: points >= TARGET_POINTS && solvedTasks >= TARGET_SOLVED_TASKS,
  };
}
