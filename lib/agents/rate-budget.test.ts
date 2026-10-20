import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";
import {
  AGENT_RATE_BUDGETS,
  agentBudgetExceededResponse,
  agentBudgetKey,
  consumeAgentBudget,
  withAgentBudgetHeaders,
} from "./rate-budget";

const HOUR = 60 * 60 * 1000;
const standard = { id: "agent-standard", burst: false };
const burst = { id: "agent-burst", burst: true };

async function spend(agent: { id: string; burst: boolean }, kind: "read" | "write", times: number, now: number) {
  for (let i = 0; i < times; i++) {
    const result = await consumeAgentBudget(agent, kind, now + i);
    if (!result.allowed) throw new Error(`rejected at request ${i + 1}`);
  }
}

describe("agent rate budgets (#440)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("uses agent:{id}:read and agent:{id}:write keys", () => {
    expect(agentBudgetKey("a1", "read")).toBe("agent:a1:read");
    expect(agentBudgetKey("a1", "write")).toBe("agent:a1:write");
  });

  it("matches the budgets in the issue", () => {
    expect(AGENT_RATE_BUDGETS.standard.write).toEqual({ max: 30, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.standard.read).toEqual({ max: 600, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.burst.write).toEqual({ max: 400, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.burst.read).toEqual({ max: 4000, windowMs: HOUR });
  });

  it("rejects a standard key at the 31st write in an hour", async () => {
    await spend(standard, "write", 30, 0);
    const result = await consumeAgentBudget(standard, "write", 1000);
    expect(result.allowed).toBe(false);
  });

  it("treats a missing burst flag as standard", async () => {
    const agent = { id: "agent-no-flag" };
    for (let i = 0; i < 30; i++) await consumeAgentBudget(agent, "write", i);
    expect((await consumeAgentBudget(agent, "write", 100)).allowed).toBe(false);
  });

  it("still has room for a burst key at 300 creates in an hour", async () => {
    await spend(burst, "write", 300, 0);
    expect((await consumeAgentBudget(burst, "write", 1000)).allowed).toBe(true);
  });

  it("rejects a burst key past 400 writes", async () => {
    await spend(burst, "write", 400, 0);
    expect((await consumeAgentBudget(burst, "write", 1000)).allowed).toBe(false);
  });

  it("does not share a counter between reads and writes", async () => {
    await spend(standard, "write", 30, 0);
    expect((await consumeAgentBudget(standard, "write", 100)).allowed).toBe(false);
    expect((await consumeAgentBudget(standard, "read", 100)).allowed).toBe(true);
  });

  it("does not share a counter between agents", async () => {
    await spend(standard, "write", 30, 0);
    expect((await consumeAgentBudget({ id: "other", burst: false }, "write", 100)).allowed).toBe(true);
  });

  it("rejects the 601st read for a standard key", async () => {
    await spend(standard, "read", 600, 0);
    expect((await consumeAgentBudget(standard, "read", 1000)).allowed).toBe(false);
  });

  it("allows writes again once the hour has passed", async () => {
    await spend(standard, "write", 30, 0);
    expect((await consumeAgentBudget(standard, "write", HOUR + 1)).allowed).toBe(true);
  });

  it("says how long to wait, in whole seconds", async () => {
    await spend(standard, "write", 30, 0);
    const result = await consumeAgentBudget(standard, "write", HOUR - 1500);
    expect(result).toMatchObject({ allowed: false, retryAfterSeconds: 2 });
  });

  it("responds 429 with Retry-After", async () => {
    const response = agentBudgetExceededResponse(42);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("too fast"), resetSeconds: 42 });
  });
});

describe("agent rate-limit quota headers (#646)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("reports the budget, what's left and when it resets on every charge", async () => {
    const first = await consumeAgentBudget(standard, "write", 0);
    expect(first).toMatchObject({ allowed: true, kind: "write", limit: 30, windowSeconds: 3600, remaining: 29, resetSeconds: 3600 });
    await spend(standard, "write", 9, 1000);
    const tenth = await consumeAgentBudget(standard, "write", 20 * 60 * 1000);
    // The first charge leaves the window at 3600 s, 40 minutes on.
    expect(tenth).toMatchObject({ remaining: 19, resetSeconds: 40 * 60 });
  });

  it("keeps reads and writes apart", async () => {
    await spend(standard, "write", 5, 0);
    expect(await consumeAgentBudget(standard, "read", 10)).toMatchObject({ kind: "read", limit: 600, remaining: 599 });
  });

  it("uses the burst limits for a burst agent", async () => {
    expect(await consumeAgentBudget(burst, "write", 0)).toMatchObject({ limit: 400, remaining: 399 });
  });

  it("names the exhausted budget and when it resets in a 429", async () => {
    await spend(standard, "write", 30, 0);
    const result = await consumeAgentBudget(standard, "write", HOUR - 1500);
    if (result.allowed) throw new Error("expected a refusal");
    const response = agentBudgetExceededResponse(result.retryAfterSeconds, result);
    expect(response.status).toBe(429);
    expect(Object.fromEntries(["Retry-After", "RateLimit-Budget", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"].map((h) => [h, response.headers.get(h)]))).toEqual({
      "Retry-After": "2",
      "RateLimit-Budget": "write",
      "RateLimit-Limit": "30",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "2",
      "RateLimit-Policy": "30;w=3600",
    });
    expect(await response.json()).toMatchObject({ budget: "write", limit: 30, resetSeconds: 2 });
  });

  it("adds headers to a successful response without inventing fields it doesn't know", async () => {
    const ok = withAgentBudgetHeaders(new Response("{}"), { kind: "read", limit: 600, windowSeconds: 3600, remaining: 12, resetSeconds: 90 });
    expect(ok.headers.get("RateLimit-Remaining")).toBe("12");
    expect(ok.headers.get("RateLimit-Reset")).toBe("90");
    const bare = withAgentBudgetHeaders(new Response("{}"), {});
    expect([...bare.headers.keys()].filter((h) => h.startsWith("ratelimit"))).toEqual([]);
  });
});
