import { z } from "zod";
export const repoInput = z.object({
  owner: z.string().min(1).max(255),
  repo: z.string().min(1).max(255),
});
/** Production CV Hub's API. Connection settings take another origin for self-hosted or local servers. */
export const DEFAULT_ORIGIN = "https://api.hub.controlvector.io";
export const pullInput = repoInput.extend({ number: z.number().int().positive() });
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const fileSchema = z.object({
  path: z.string().min(1).max(4096),
  oldPath: z.string().max(4096).optional(),
  status: z.enum(["added", "deleted", "modified", "renamed", "copied"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().optional(),
});
/** Everything a native review's loaders need, pinned to the revisions the review opened at. */
export const contextSchema = pullInput.extend({
  connectionId: z.string(),
  baseSha: sha,
  headSha: sha,
});
export const sideSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), content: z.string().max(2 * 1024 * 1024) }),
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("binary"), size: z.number().nonnegative().optional() }),
  z.object({
    kind: z.literal("limited"),
    size: z.number().nonnegative().optional(),
    reason: z.string().max(512),
  }),
  z.object({ kind: z.literal("error"), code: z.string().max(64), message: z.string().max(512) }),
]);
export const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  body: z.string().nullable().optional(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  author: z.object({ username: z.string() }),
  isDraft: z.boolean().optional(),
  sourceSha: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  reviewCount: z.number().optional(),
});
export type Pull = z.infer<typeof pullSchema>;
export function pullPath(input: z.infer<typeof pullInput>): string {
  return `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`;
}
export type Orca = {
  commands: { register(id: string, handler: (args: unknown) => unknown): void };
  host: { call(method: string, params?: unknown): Promise<unknown> };
};
