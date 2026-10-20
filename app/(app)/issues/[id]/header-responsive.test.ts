import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("Bug detail header responsive layout (#698)", () => {
  it("renders a compact mobile action row pinned directly under the title before badges and votes", () => {
    // Mobile action row must be directly under the title
    expect(pageSource).toMatch(
      /<h1[\s\S]*?<\/h1>[\s\S]*?data-testid="mobile-actions-row"[\s\S]*?Badge[\s\S]*?<VoteButton/
    );

    // Mobile action row has horizontal scroll and is hidden on desktop (sm:hidden)
    const mobileRowMatch = pageSource.match(
      /data-testid="mobile-actions-row"[\s\S]*?className="([^"]+)"/
    );
    expect(mobileRowMatch).toBeTruthy();
    const mobileClasses = mobileRowMatch![1];
    expect(mobileClasses).toContain("overflow-x-auto");
    expect(mobileClasses).toContain("sm:hidden");
    expect(mobileClasses).toContain("flex");
    expect(mobileClasses).toContain("gap-2");
  });

  it("includes SelfAssignButton in the header action row so Assign is immediately reachable", () => {
    expect(pageSource).toMatch(
      /headerActions[\s\S]*?canSelfAssign[\s\S]*?<SelfAssignButton/
    );
  });

  it("collapses secondary badges on mobile behind a +N overflow control while keeping status and severity visible", () => {
    // Badges section has workflow badges (status and severity) visible
    expect(pageSource).toMatch(
      /statusClass\[bug\.status\][\s\S]*?severityClass\[bug\.severity\]/
    );

    // Details summary with +extraBadgeCount exists on mobile and is hidden on desktop (sm:hidden)
    expect(pageSource).toMatch(
      /<details className="group sm:contents">[\s\S]*?<summary[\s\S]*?\+\{extraBadgeCount\}[\s\S]*?<\/summary>/
    );

    // Secondary badges are wrapped in sm:contents so on desktop they flow inline naturally without element duplication
    expect(pageSource).toMatch(
      /<span className="contents">[\s\S]*?bug\.type[\s\S]*?bug\.category[\s\S]*?voteCount/
    );
  });

  it("preserves the desktop header action layout and danger zone position", () => {
    // Desktop header action container is preserved
    expect(pageSource).toContain(
      '<div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:pt-6 print:hidden">'
    );

    // Danger zone remains at the bottom of the page
    expect(pageSource).toMatch(/Danger zone[\s\S]*?<DeleteIssueButton/);
  });
});
