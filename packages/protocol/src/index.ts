/**
 * The Hyphae wire protocol (ADR Part 4).
 *
 * Two directions:
 *   - client -> hub: hello, change, ack
 *   - hub -> client: manifest, changed, conflict, resolved, presence, error
 *
 * Content normally travels by reference (a hash, resolved through R2). Small
 * files may inline their base64 content (ADR-020).
 */

import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const blobHashSchema = z.string().min(1);
export const manifestEntrySchema = z.object({
  blobHash: blobHashSchema,
  version: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedAt: z.number(),
});

export const manifestSchema = z.object({
  entries: z.record(z.string(), manifestEntrySchema),
});

// ---------------------------------------------------------------------------
// client -> hub
// ---------------------------------------------------------------------------

export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int().optional(),
  actorId: z.string(),
  repoId: z.string(),
  manifestSince: z.number().int().optional(),
});

/**
 * A file change. Exactly one of `newHash` (by reference, the normal path) or
 * `contentBase64` (base64, small files only) must be present. `newHash: null`
 * with no content means a tombstone (delete).
 */
export const changeMessageSchema = z
  .object({
    type: z.literal("change"),
    id: z.string(),
    path: z.string(),
    baseHash: blobHashSchema.nullable(),
    newHash: blobHashSchema.nullable().optional(),
    contentBase64: z.string().optional(),
    sig: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    const hasContent = m.contentBase64 !== undefined;
    const hasHash = m.newHash !== undefined;
    // Exactly one representation: a by-reference hash OR inline content, never
    // both (that would let hash and bytes disagree) and never neither.
    if (hasContent && hasHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a change must not carry both newHash and contentBase64",
        path: ["newHash"],
      });
    }
    if (!hasContent && !hasHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a change must carry either newHash or contentBase64",
        path: ["newHash"],
      });
    }
    // A tombstone (newHash null) cannot also carry inline content.
    if (hasContent && m.newHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a change cannot be both a tombstone (newHash null) and inline content",
        path: ["contentBase64"],
      });
    }
  });

export const ackMessageSchema = z.object({
  type: z.literal("ack"),
  changeId: z.string(),
});

export const clientMessageSchema = z.union([
  helloMessageSchema,
  changeMessageSchema,
  ackMessageSchema,
]);

// ---------------------------------------------------------------------------
// hub -> client
// ---------------------------------------------------------------------------

export const manifestMessageSchema = z.object({
  type: z.literal("manifest"),
  entries: z.record(z.string(), manifestEntrySchema),
});

export const changedMessageSchema = z.object({
  type: z.literal("changed"),
  path: z.string(),
  newHash: blobHashSchema.nullable(),
  version: z.number().int().nonnegative(),
  by: z.string(),
});

export const conflictMessageSchema = z.object({
  type: z.literal("conflict"),
  changeId: z.string(),
  path: z.string(),
  keptBoth: z.boolean().optional(),
});

export const resolvedMessageSchema = z.object({
  type: z.literal("resolved"),
  changeId: z.string(),
  path: z.string(),
  newHash: blobHashSchema.nullable(),
});

export const presenceActorSchema = z.object({
  actorId: z.string(),
  displayName: z.string(),
  kind: z.enum(["human", "agent"]),
});

export const presenceMessageSchema = z.object({
  type: z.literal("presence"),
  actors: z.array(presenceActorSchema),
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const hubMessageSchema = z.union([
  manifestMessageSchema,
  changedMessageSchema,
  conflictMessageSchema,
  resolvedMessageSchema,
  presenceMessageSchema,
  errorMessageSchema,
]);

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

export const presignRequestSchema = z.object({
  hash: blobHashSchema,
  method: z.enum(["PUT", "GET"]).default("PUT"),
});

export const presignResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.number(),
});

export const createRepoSchema = z.object({
  name: z.string().min(1),
});

export const repoResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  remote: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type ChangeMessage = z.infer<typeof changeMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ManifestMessage = z.infer<typeof manifestMessageSchema>;
export type ChangedMessage = z.infer<typeof changedMessageSchema>;
export type ConflictMessage = z.infer<typeof conflictMessageSchema>;
export type ResolvedMessage = z.infer<typeof resolvedMessageSchema>;
export type PresenceMessage = z.infer<typeof presenceMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type HubMessage = z.infer<typeof hubMessageSchema>;

export type PresignRequest = z.infer<typeof presignRequestSchema>;
export type PresignResponse = z.infer<typeof presignResponseSchema>;
export type CreateRepoRequest = z.infer<typeof createRepoSchema>;
export type RepoResponse = z.infer<typeof repoResponseSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

export function parseHubMessage(raw: unknown): HubMessage {
  return hubMessageSchema.parse(raw);
}

export function safeParseHubMessage(raw: unknown) {
  return hubMessageSchema.safeParse(raw);
}
