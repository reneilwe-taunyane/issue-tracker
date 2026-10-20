import {
  fieldNamesOf,
  fieldTypeOf,
  requiredFieldsOf,
  type SubmissionSchema,
} from "@/lib/validations/job";

/**
 * Validates one submission row against a job's schema (#617).
 *
 * This is deliberately small: it covers the checks a research brief needs —
 * required fields, the right shape, and nothing unexpected — without pulling
 * in a JSON Schema engine. A `null` schema accepts any object.
 */

export type RowViolation = { field?: string; message: string };

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Every reason `row` does not satisfy `schema`. Empty means it is valid. */
export function validateSubmissionRow(
  schema: SubmissionSchema | null | undefined,
  row: Record<string, unknown>,
): RowViolation[] {
  const violations: RowViolation[] = [];

  // A key that is present but blank is the same as not sending it.
  const isBlank = (value: unknown) =>
    value === undefined || value === null || (typeof value === "string" && value.trim() === "");

  for (const field of requiredFieldsOf(schema)) {
    if (isBlank(row[field])) {
      violations.push({ field, message: `"${field}" is required.` });
    }
  }

  for (const [field, value] of Object.entries(row)) {
    if (isBlank(value)) continue;
    const type = fieldTypeOf(schema, field);
    if (type && !typeMatches(type, value)) {
      violations.push({ field, message: `"${field}" must be a ${type}.` });
    }
  }

  // Reject unknown fields only when the schema names an exhaustive set.
  const allowed = fieldNamesOf(schema);
  if (allowed) {
    const allowedSet = new Set(allowed);
    for (const field of Object.keys(row)) {
      if (!allowedSet.has(field)) {
        violations.push({ field, message: `"${field}" is not a field of this job.` });
      }
    }
  }

  return violations;
}

/**
 * The dedupe value for a row, or null when the schema field is missing or not
 * a primitive. Callers reject null: a row without a key can't be deduplicated.
 */
export function dedupeValue(row: Record<string, unknown>, dedupeKey: string): string | null {
  const raw = row[dedupeKey];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  // Arrays and objects are not stable identity for a research row.
  return null;
}

export function submissionViolationsMessage(violations: RowViolation[]): string {
  const first = violations[0];
  if (!first) return "The submission is invalid.";
  return violations.length === 1
    ? first.message
    : `${first.message} (${violations.length - 1} more problem${violations.length === 2 ? "" : "s"})`;
}
