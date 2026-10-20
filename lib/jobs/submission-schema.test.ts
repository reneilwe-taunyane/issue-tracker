import { describe, expect, it } from "vitest";
import { dedupeValue, validateSubmissionRow } from "./submission-schema";

describe("validateSubmissionRow (#617)", () => {
  it("accepts anything for a null schema", () => {
    expect(validateSubmissionRow(null, { anything: 1 })).toEqual([]);
  });

  it("requires every field of an array schema", () => {
    const violations = validateSubmissionRow(["url", "title"], { url: "https://x.dev" });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe("title");
  });

  it("treats a blank string as missing", () => {
    expect(validateSubmissionRow(["url"], { url: "   " })[0]?.field).toBe("url");
  });

  it("checks declared types", () => {
    const schema = { properties: { count: { type: "integer" } } } as const;
    expect(validateSubmissionRow(schema, { count: 3 })).toEqual([]);
    expect(validateSubmissionRow(schema, { count: 3.5 })[0]?.message).toContain("integer");
  });

  it("rejects unknown fields when the schema names an exhaustive set", () => {
    const schema = ["url"];
    const violations = validateSubmissionRow(schema, { url: "https://x.dev", extra: "nope" });
    expect(violations.map((v) => v.field)).toContain("extra");
  });

  it("rejects unknown fields when the object schema names a field set", () => {
    const schema = { properties: { url: { type: "string" } } } as const;
    expect(validateSubmissionRow(schema, { url: "x", note: "ok" })[0]?.field).toBe("note");
  });
});

describe("dedupeValue (#617)", () => {
  it("returns a trimmed string", () => {
    expect(dedupeValue({ url: "  https://x.dev  " }, "url")).toBe("https://x.dev");
  });

  it("returns numbers and booleans as strings", () => {
    expect(dedupeValue({ n: 42 }, "n")).toBe("42");
    expect(dedupeValue({ b: true }, "b")).toBe("true");
  });

  it("returns null for missing, blank, or non-primitive values", () => {
    expect(dedupeValue({}, "url")).toBeNull();
    expect(dedupeValue({ url: "" }, "url")).toBeNull();
    expect(dedupeValue({ url: ["a"] }, "url")).toBeNull();
    expect(dedupeValue({ url: { a: 1 } }, "url")).toBeNull();
  });
});
