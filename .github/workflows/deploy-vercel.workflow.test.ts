import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Vercel deploy must queue behind CI + the malware gate, on a pinned CLI (#579). */
const workflow = readFileSync(".github/workflows/deploy-vercel.yml", "utf8");

describe("Vercel deploy workflow (#579)", () => {
  it("only runs after CI finishes, like the Coolify deploy", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["CI"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).not.toMatch(/^\s{2}push:/m);
  });

  it("waits for the malware gate before deploying", () => {
    expect(workflow).toContain("Malware Scan (CI Gate)");
  });

  it("pins the Vercel CLI instead of @latest", () => {
    expect(workflow).not.toContain("vercel@latest");
    expect(workflow).toMatch(/vercel@\d+/);
  });

  it("names the environment it actually deploys to", () => {
    expect(workflow).toContain("name: Deploy (Vercel Production)");
    expect(workflow).toContain("--prod");
  });
});
