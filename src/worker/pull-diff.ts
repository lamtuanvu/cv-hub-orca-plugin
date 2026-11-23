import { z } from "zod";

/** Identifiers of one pull request, and the API path CV Hub's own web page uses. */
export const repoInput = z.object({
  owner: z.string().min(1).max(255),
  repo: z.string().min(1).max(255),
});
export const pullInput = repoInput.extend({ number: z.number().int().positive() });
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export function pullPath(input: z.infer<typeof pullInput>): string {
  return `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`;
}

const fileSchema = z.object({
  path: z.string().min(1).max(4096),
  oldPath: z.string().max(4096).optional(),
  status: z.enum(["added", "deleted", "modified", "renamed", "copied"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().optional(),
});

/** The PR diff exactly as CV Hub's own web page receives it (`GET .../pulls/:n/diff`). Patches
 *  are hunks only, computed over `baseSha...headSha`, so they are relative to the merge base. */
export const diffSchema = z.object({
  diff: z.object({
    baseSha: sha,
    headSha: sha,
    files: z.array(
      fileSchema.extend({ patch: z.string().optional(), truncated: z.boolean().optional() }),
    ),
  }),
});
export type PullDiff = z.infer<typeof diffSchema>["diff"];
export type PullDiffFile = PullDiff["files"][number];
export type DiffClient = { json(path: string, maxBytes: number): Promise<unknown> };

/** CV Hub caps patches at 4 MiB in total; JSON escaping and file metadata come on top. */
export const DIFF_LIMIT = 32 * 1024 * 1024;

export async function fetchPullDiff(client: DiffClient, pull: z.infer<typeof pullInput>): Promise<PullDiff> {
  return diffSchema.parse(await client.json(`${pullPath(pull)}/diff`, DIFF_LIMIT)).diff;
}

/** The panel draws at most 64 KiB of patch text per file; leave headroom for its own chrome. */
const PATCH_LIMIT = 60 * 1024;
/** The whole answer must stay well inside Orca's 1 MiB request budget and the
 *  panel's ~512 KiB render budget, metadata included. */
const TOTAL_PATCH_LIMIT = 320 * 1024;
/** A tree of changed files stays readable; beyond this the panel says how many there are. */
const FILE_LIMIT = 400;
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** One file's patch, cut to what the panel can show. `truncated` is set when CV Hub
 *  already cut the patch or this cut shortens it further; binary files carry none. */
export function panelFile(file: PullDiffFile, budget: { total: number }): {
  path: string;
  oldPath: string | null;
  status: PullDiffFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  patch: string | null;
} {
  const hubTruncated = file.truncated === true;
  const binary = file.binary === true;
  if (binary || file.patch === undefined)
    return {
      path: file.path,
      oldPath: file.oldPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary,
      truncated: hubTruncated,
      patch: null,
    };
  let patch: string | null = file.patch;
  let truncated = hubTruncated;
  if (byteLength(patch) > PATCH_LIMIT) {
    // Cut on a line boundary when one is nearby, so the diff stays readable.
    const cut = patch.lastIndexOf("\n", PATCH_LIMIT);
    patch = patch.slice(0, cut > PATCH_LIMIT * 0.8 ? cut + 1 : PATCH_LIMIT);
    truncated = true;
  }
  if (budget.total + byteLength(patch) > TOTAL_PATCH_LIMIT) {
    patch = null;
    truncated = true;
  } else budget.total += byteLength(patch);
  return {
    path: file.path,
    oldPath: file.oldPath ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary,
    truncated,
    patch,
  };
}

/** The diff as the panel shows it: every changed file with a patch that fits its
 *  diff view, plus the exact revisions the patch was computed from. */
export function diffForPanel(diff: PullDiff) {
  const budget = { total: 0 };
  const shown = diff.files.slice(0, FILE_LIMIT);
  return {
    headSha: diff.headSha,
    baseSha: diff.baseSha,
    totalFiles: diff.files.length,
    filesTruncated: diff.files.length > shown.length,
    files: shown.map((file) => panelFile(file, budget)),
  };
}
