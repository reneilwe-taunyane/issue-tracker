import { z } from "zod";
import { displayNameSchema } from "@/lib/display-name";
import { BCRYPT_MAX_PASSWORD_BYTES } from "@/lib/password";
import { isGitHubUrl, splitProofLinkLines } from "@/lib/proof-links";
import { stripGitHubMarkup } from "@/lib/github-paste";

export const severities = ["low", "medium", "high", "critical"] as const;
export const statuses = ["open", "in_progress", "resolved", "closed"] as const;

export const severitySchema = z.enum(severities);
export const statusSchema = z.enum(statuses);

const MAX_PROOF_LINKS = 20;

/**
 * A User.id. Not `.cuid()`: Google sign-in can fall back to `randomUUID()`
 * ids (lib/google-user.ts), and those users must still be assignable (#420).
 * The actions look the user up and reject unknown ids.
 */
const userIdSchema = z.string().trim().min(1).max(191);

/** Optional newline-separated GitHub URLs for issues / PRs. */
export const proofLinksInputSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value?.trim()) return [];

    const rawLines = value.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]?.trim();
      if (!line) continue;
      if (!isGitHubUrl(line)) {
        ctx.addIssue({
          code: "custom",
          message: `Line ${i + 1} is not a valid GitHub URL: "${line}"`,
        });
        return z.NEVER;
      }
    }

    const rawLinks = splitProofLinkLines(value);
    const links = [...new Set(rawLinks)];
    const count =
      rawLinks.length > links.length && rawLinks.length > MAX_PROOF_LINKS
        ? rawLinks.length
        : links.length;
    if (links.length > MAX_PROOF_LINKS || rawLinks.length > MAX_PROOF_LINKS) {
      ctx.addIssue({
        code: "custom",
        message: `You entered ${count} links. At most ${MAX_PROOF_LINKS} proof links are allowed.`,
      });
      return z.NEVER;
    }
    return links;
  });

/** Create payload — status is rejected; the server always sets `open`. */
export const createBugSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters")
      .max(200, "Title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .transform((val) => stripGitHubMarkup(val))
      .refine((val) => val.length >= 10, {
        message: "Description must be at least 10 characters",
      })
      .refine((val) => val.length <= 5000, {
        message: "Description cannot exceed 5000 characters",
      }),
    severity: severitySchema.default("medium"),
    typeId: z.string().optional().nullable().or(z.literal("")),
    assigneeId: userIdSchema.optional().or(z.literal("")),
    categoryId: z.string().optional().or(z.literal("")),
    proofLinks: proofLinksInputSchema,
  })
  .strict();

export const updateBugSchema = z.object({
  status: statusSchema.optional(),
  typeId: z.string().nullable().optional().or(z.literal("")),
  assigneeId: userIdSchema.nullable().optional().or(z.literal("")),
  severity: severitySchema.optional(),
  categoryId: z.string().nullable().optional().or(z.literal("")),
});

export const editBugContentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters")
      .max(200, "Title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .transform((val) => stripGitHubMarkup(val))
      .refine((val) => val.length >= 10, {
        message: "Description must be at least 10 characters",
      })
      .refine((val) => val.length <= 5000, {
        message: "Description cannot exceed 5000 characters",
      }),
  })
  .strict();

/** Replace an issue's proof links after it was filed (#737). Empty clears them. */
export const editProofLinksSchema = z
  .object({
    proofLinks: proofLinksInputSchema,
  })
  .strict();

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Platform name must be at least 2 characters")
    .max(50, "Platform name must be at most 50 characters"),
});

/** Alias for categorySchema matching the user-facing Platform domain terminology (#355). */
export const platformSchema = categorySchema;

export const commentTypeValues = [
  "comment",
  "bid",
  "review",
  "delivery",
  "request_to_merge",
] as const;

export type CommentType = (typeof commentTypeValues)[number];

export const commentTypeSchema = z.enum(commentTypeValues);

export const commentSchema = z.object({
  body: z
    .string()
    .trim()
    .transform((val) => stripGitHubMarkup(val))
    .refine((val) => val.length >= 1, {
      message: "Comment cannot be empty",
    })
    .refine((val) => val.length <= 2000, {
      message: "Comment cannot exceed 2000 characters",
    }),
  parentId: z
    .string()
    .cuid()
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  type: commentTypeSchema.optional().default("comment"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .refine(
    (password) =>
      new TextEncoder().encode(password).length <= BCRYPT_MAX_PASSWORD_BYTES,
    {
      message:
        "Password is too long: bcrypt keeps only the first 72 bytes, so choose something shorter.",
    },
  );

export const signupSchema = z
  .object({
    name: displayNameSchema,
    email: z
      .string()
      .trim()
      .email("Enter a valid email")
      .transform((value) => value.toLowerCase()),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .email("Enter a valid email")
    .transform((value) => value.toLowerCase()),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(1, "Reset link is invalid or expired"),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * An EVM wallet address (#618): `0x` followed by 40 hex characters. Shape
 * only — no checksum validation — because the person is the one who chooses
 * where their points would go. Blank clears the address, which is why "" is
 * accepted here and comes out of the transform as `null`.
 */
export const walletAddressSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || /^0x[0-9a-fA-F]{40}$/.test(value), {
    message: "Enter a valid EVM address: 0x followed by 40 hex characters.",
  })
  .transform((value) => (value === "" ? null : value));
