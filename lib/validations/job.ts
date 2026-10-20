import { z } from "zod";

/**
 * Research jobs (#617): a person posts a brief, many agents submit rows, and
 * independent reviewers accept them. This module is additive — the bug flow is
 * untouched.
 */

/** A JSON-Schema-like `type` we understand in a submission row. */
const fieldTypes = ["string", "number", "integer", "boolean", "array", "object", "null"] as const;
const fieldTypeSchema = z.enum(fieldTypes);

const fieldNameSchema = z
  .string()
  .trim()
  .min(1, "A field name cannot be empty")
  .max(100, "A field name must be at most 100 characters")
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "A field name must be a simple identifier");

/**
 * The description of one submission row. Two shapes are accepted (#617):
 * an array of field names (all required), or a JSON-Schema-like object with
 * `properties` and optional `required`.
 */
const propertiesShape = z
  .object({
    properties: z.record(
      fieldNameSchema,
      z
        .object({
          type: fieldTypeSchema.optional(),
          description: z.string().trim().max(500).optional(),
        })
        .passthrough(),
    ),
    required: z.array(fieldNameSchema).max(100).optional(),
  })
  .strict();

export const submissionSchemaSchema = z.union([z.array(fieldNameSchema).min(1).max(100), propertiesShape]);

export type SubmissionSchema = z.infer<typeof submissionSchemaSchema>;

/** The field names a submission schema requires, or an empty list when free-form. */
export function requiredFieldsOf(schema: SubmissionSchema | null | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema)) return [...new Set(schema)];
  return [...new Set(schema.required ?? [])];
}

/** The field names a submission schema allows, or null when it allows anything. */
export function fieldNamesOf(schema: SubmissionSchema | null | undefined): string[] | null {
  if (!schema) return null;
  if (Array.isArray(schema)) return [...new Set(schema)];
  return Object.keys(schema.properties);
}

/** The declared type of one field, when the schema names it. */
export function fieldTypeOf(schema: SubmissionSchema | null | undefined, field: string): string | null {
  if (!schema || Array.isArray(schema)) return null;
  return schema.properties[field]?.type ?? null;
}

const idSchema = z.string().trim().min(1).max(191);

/**
 * Create payload for a job (#617). `dedupeKey` names the submission-row field
 * deduplication is keyed on, so it must be one of the schema's fields when a
 * schema is present.
 */
export const createJobSchema = z
  .object({
    brief: z
      .string()
      .trim()
      .min(10, "The brief must be at least 10 characters")
      .max(5000, "The brief must be at most 5000 characters"),
    submissionSchema: submissionSchemaSchema.nullable().optional(),
    dedupeKey: fieldNameSchema,
    maxSubmissions: z.coerce
      .number()
      .int("maxSubmissions must be a whole number")
      .min(1, "maxSubmissions must be at least 1")
      .max(1_000_000, "maxSubmissions is too large"),
    pointsPerAccepted: z.coerce
      .number()
      .int("pointsPerAccepted must be a whole number")
      .min(0, "pointsPerAccepted cannot be negative")
      .max(10_000, "pointsPerAccepted is too large"),
    projectId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fields = fieldNamesOf(value.submissionSchema ?? null);
    if (fields && !fields.includes(value.dedupeKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["dedupeKey"],
        message: `dedupeKey "${value.dedupeKey}" is not one of the submission fields.`,
      });
    }
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;

/** The submit envelope: the row lives under `data` (#617). */
export const submitJobSchema = z
  .object({
    data: z.record(z.string(), z.unknown()),
    projectId: idSchema.optional(),
  })
  .strict();

export type SubmitJobInput = z.infer<typeof submitJobSchema>;

export const JOB_VERDICTS = ["accept", "reject"] as const;
export const jobVerdictSchema = z.enum(JOB_VERDICTS);

/** A reviewer's verdict on a submission (#617). */
export const jobReviewSchema = z
  .object({
    verdict: jobVerdictSchema,
    notes: z.string().trim().max(2000, "Notes must be at most 2000 characters").optional(),
  })
  .strict();

export type JobReviewInput = z.infer<typeof jobReviewSchema>;
