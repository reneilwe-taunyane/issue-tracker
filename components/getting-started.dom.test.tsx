// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/onboarding", () => ({ dismissGettingStartedAction: vi.fn() }));

import { GettingStarted } from "./getting-started";

afterEach(cleanup);

const steps = [
  { id: "workspace" as const, label: "Create your workspace", hint: "h", href: "/tenants", done: true },
  { id: "project" as const, label: "Set up a project", hint: "h", href: "/projects", done: true },
  { id: "issue" as const, label: "Report the first issue", hint: "Say what you expected", href: "/issues/new", done: false },
  { id: "invite" as const, label: "Invite a teammate", hint: "h", href: "/tenants/acme", done: false },
];

describe("GettingStarted (#641)", () => {
  it("shows progress and links only the steps still to do", () => {
    render(<GettingStarted tenantId="t1" workspaceName="Acme" steps={steps} />);
    expect(screen.getByRole("heading", { name: "Getting started with Acme" })).toBeInTheDocument();
    expect(screen.getByText(/2 of 4 done/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Report the first issue/ })).toHaveAttribute("href", "/issues/new");
    expect(screen.getByRole("link", { name: /Invite a teammate/ })).toHaveAttribute("href", "/tenants/acme");
    expect(screen.queryByRole("link", { name: /Create your workspace/ })).toBeNull();
    expect(screen.getByText("Say what you expected")).toBeInTheDocument();
  });

  it("can be dismissed for this workspace", () => {
    const { container } = render(<GettingStarted tenantId="t1" workspaceName="Acme" steps={steps} />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(container.querySelector('input[name="tenantId"]')).toHaveValue("t1");
  });
});
