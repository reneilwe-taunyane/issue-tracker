import { describe, expect, it } from "vitest";
import {
  createJobSchema,
  jobReviewSchema,
  requiredFieldsOf,
  submissionSchemaSchema,
  submitJobSchema,
} from "./job";

describe("createJobSchema (#617)", () => {
  const base = {
    brief: "Find every public API endpoint of the target and its docs URL.",
    dedupeKey: "url",
    maxSubmissions: 50,
    pointsPerAccepted: 5,
  };

  it("accepts a valid job", () => {
    const result = createJobSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("coerces numeric strings from a form", () => {
    const result = createJobSchema.safeParse({ ...base, maxSubmissions: "10", pointsPerAccepted: "3" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSubmissions).toBe(10);
      expect(result.data.pointsPerAccepted).toBe(3);
    }
  });

  it("rejects a short brief", () => {
    expect(createJobSchema.safeParse({ ...base, brief: "hi" }).success).toBe(false);
  });

  it("rejects a non-positive maxSubmissions", () => {
    expect(createJobSchema.safeParse({ ...base, maxSubmissions: 0 }).success).toBe(false);
  });

  it("rejects a negative pointsPerAccepted", () => {
    expect(createJobSchema.safeParse({ ...base, pointsPerAccepted: -1 }).success).toBe(false);
  });

  it("rejects a dedupeKey that is not a field of the schema", () => {
    const result = createJobSchema.safeParse({
      ...base,
      submissionSchema: { properties: { name: { type: "string" } } },
      dedupeKey: "url",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("dedupeKey");
    }
  });

  it("accepts a dedupeKey that is one of the array-shaped schema fields", () => {
    const result = createJobSchema.safeParse({
      ...base,
      submissionSchema: ["url", "title"],
      dedupeKey: "url",
    });
    expect(result.success).toBe(true);
  });
});

describe("submissionSchemaSchema (#617)", () => {
  it("accepts an array of field names", () => {
    expect(submissionSchemaSchema.safeParse(["a", "b"]).success).toBe(true);
  });

  it("accepts a properties/required object", () => {
    expect(
      submissionSchemaSchema.safeParse({ properties: { url: { type: "string" } }, required: ["url"] }).success,
    ).toBe(true);
  });

  it("rejects an unknown field type", () => {
    expect(
      submissionSchemaSchema.safeParse({ properties: { url: { type: "datetime" } } }).success,
    ).toBe(false);
  });

  it("rejects invalid field names", () => {
    expect(submissionSchemaSchema.safeParse(["has space"]).success).toBe(false);
  });
});

describe("requiredFieldsOf (#617)", () => {
  it("returns nothing for a null schema", () => {
    expect(requiredFieldsOf(null)).toEqual([]);
  });

  it("returns every field for an array schema", () => {
    expect(requiredFieldsOf(["url", "title"])).toEqual(["url", "title"]);
  });

  it("returns only the declared required fields for an object schema", () => {
    expect(requiredFieldsOf({ properties: { url: {}, title: {} }, required: ["url"] })).toEqual(["url"]);
  });

  it("requires nothing when the object schema omits required", () => {
    expect(requiredFieldsOf({ properties: { url: {} } })).toEqual([]);
  });
});

describe("submitJobSchema (#617)", () => {
  it("accepts a data envelope", () => {
    expect(submitJobSchema.safeParse({ data: { url: "https://x.dev" } }).success).toBe(true);
  });

  it("rejects a body without data", () => {
    expect(submitJobSchema.safeParse({ url: "https://x.dev" }).success).toBe(false);
  });
});

describe("jobReviewSchema (#617)", () => {
  it("accepts accept and reject", () => {
    expect(jobReviewSchema.safeParse({ verdict: "accept" }).success).toBe(true);
    expect(jobReviewSchema.safeParse({ verdict: "reject", notes: "dupe" }).success).toBe(true);
  });

  it("rejects an unknown verdict", () => {
    expect(jobReviewSchema.safeParse({ verdict: "maybe" }).success).toBe(false);
  });
});
