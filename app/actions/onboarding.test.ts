import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "dave", role: "user" })) }));
const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { membership: { findUnique } } }));

import { dismissGettingStartedAction } from "./onboarding";
import { GETTING_STARTED_COOKIE } from "@/lib/onboarding";

function form(tenantId: string) {
  const data = new FormData();
  data.set("tenantId", tenantId);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  jar.get.mockReturnValue({ value: "older" });
});

describe("dismissGettingStartedAction (#641)", () => {
  it("remembers the dismissal for a workspace the person belongs to", async () => {
    findUnique.mockResolvedValue({ tenantId: "acme" });
    await dismissGettingStartedAction(form("acme"));
    expect(jar.set).toHaveBeenCalledWith(GETTING_STARTED_COOKIE, "older,acme", expect.objectContaining({ httpOnly: true, path: "/" }));
  });

  it("ignores a workspace the person isn't in", async () => {
    findUnique.mockResolvedValue(null);
    await dismissGettingStartedAction(form("someone-elses"));
    expect(jar.set).not.toHaveBeenCalled();
  });
});
