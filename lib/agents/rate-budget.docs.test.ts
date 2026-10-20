import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { AGENT_RATE_BUDGETS, agentBudgetExceededResponse } from "./rate-budget";

/**
 * The agent docs (served as /llms.txt) must state the budgets the code
 * enforces (#551). This fails when either side changes without the other.
 */
const doc = readFileSync(path.resolve(__dirname, "../../docs/ziki-for-agents.md"), "utf8");

function budgetRow(label: string): { writes: number; reads: number } {
  const row = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|`, "m").exec(doc);
  if (!row) throw new Error(`No "${label}" row in the Rate Budgets table`);
  return { writes: Number(row[1]), reads: Number(row[2]) };
}

describe("llms.txt rate budgets match the code (#551)", () => {
  it("documents the standard budget", () => {
    expect(budgetRow("Standard")).toEqual({
      writes: AGENT_RATE_BUDGETS.standard.write.max,
      reads: AGENT_RATE_BUDGETS.standard.read.max,
    });
  });

  it("documents the burst budget", () => {
    expect(budgetRow("Burst")).toEqual({
      writes: AGENT_RATE_BUDGETS.burst.write.max,
      reads: AGENT_RATE_BUDGETS.burst.read.max,
    });
  });

  it("says the window is an hour, as the code's is", () => {
    for (const budget of [AGENT_RATE_BUDGETS.standard, AGENT_RATE_BUDGETS.burst]) {
      expect(budget.write.windowMs).toBe(60 * 60 * 1000);
      expect(budget.read.windowMs).toBe(60 * 60 * 1000);
    }
    expect(doc).toMatch(/\| Budget \| Writes per hour \| Reads per hour \|/);
  });

  it("shows the 429 body the code sends (#646)", async () => {
    const response = agentBudgetExceededResponse(412, { kind: "write", limit: 30, resetSeconds: 412 });
    const body = await response.json();
    expect(body).toEqual({ error: RATE_LIMIT_MESSAGE, budget: "write", limit: 30, resetSeconds: 412 });
    expect(doc).toContain(
      `{ "error": ${JSON.stringify(RATE_LIMIT_MESSAGE)}, "budget": "write", "limit": 30, "resetSeconds": 412 }`,
    );
  });

  it("documents every quota header the code sends (#646)", () => {
    const response = agentBudgetExceededResponse(412, { kind: "write", limit: 30, windowSeconds: 3600, resetSeconds: 412 });
    const names = [...response.headers.keys()].filter((name) => name.startsWith("ratelimit-"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const proper = name.replace(/(^|-)([a-z])/g, (_m, dash: string, c: string) => dash + c.toUpperCase()).replace("Ratelimit", "RateLimit");
      expect(doc).toContain("`" + proper + "`");
    }
  });
});
