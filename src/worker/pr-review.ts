import { z } from "zod";
import { contextSchema, fileSchema, sideSchema, pullPath, sha } from "../shared/contracts";

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
const blobSchema = z.object({
  size: z.number().nonnegative().optional(),
  isBinary: z.boolean(),
  content: z.string().nullable(),
});
type Side = z.infer<typeof sideSchema>;
type Context = z.infer<typeof contextSchema>;
type PullRef = { owner: string; repo: string; number: number };
export type ReviewClient = { connectionId: string; json(path: string, maxBytes: number): Promise<unknown> };

/** Orca's limit for one side of a native diff. */
const SIDE_LIMIT = 2 * 1024 * 1024;
/** CV Hub caps patches at 4 MiB in total; JSON escaping and file metadata come on top. */
const DIFF_LIMIT = 32 * 1024 * 1024;
const failed = (code: string, message: string): Side => ({ kind: "error", code, message });
const STALE = failed(
  "revision_changed",
  "The pull request changed since this review opened. Reopen it from the CV Hub panel.",
);

export async function fetchDiff(client: ReviewClient, pull: PullRef): Promise<PullDiff> {
  return diffSchema.parse(await client.json(`${pullPath(pull)}/diff`, DIFF_LIMIT)).diff;
}

/** Recent diffs, keyed by the exact revisions a review was opened at. The snapshot context Orca
 *  hands back to the loader is capped at 16 KiB, too small for patches, so the loader looks the
 *  patch up here, and refetches after a worker restart, refusing if the PR has since moved. */
export class DiffCache {
  private readonly entries = new Map<string, PullDiff>();
  constructor(private readonly capacity = 4) {}
  private static key(connectionId: string, pull: PullRef, base: string, head: string) {
    return JSON.stringify([connectionId, pull.owner, pull.repo, pull.number, base, head]);
  }
  put(connectionId: string, pull: PullRef, diff: PullDiff) {
    const key = DiffCache.key(connectionId, pull, diff.baseSha, diff.headSha);
    this.entries.delete(key);
    this.entries.set(key, diff);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  async get(context: Context, client: ReviewClient): Promise<PullDiff | null> {
    const hit = this.entries.get(DiffCache.key(context.connectionId, context, context.baseSha, context.headSha));
    if (hit) return hit;
    const diff = await fetchDiff(client, context);
    if (diff.baseSha !== context.baseSha || diff.headSha !== context.headSha) return null;
    this.put(context.connectionId, context, diff);
    return diff;
  }
}

/** Rebuild the pre-image of a file from its post-image and a hunks-only unified diff by undoing
 *  each hunk. Returns null when the patch doesn't match the post-image. */
export function reversePatch(modified: string, patch: string): string | null {
  const endsWithNewline = modified.endsWith("\n");
  const after = modified === "" ? [] : modified.split("\n");
  if (endsWithNewline) after.pop();
  const lines = patch === "" ? [] : patch.split("\n");
  if (patch.endsWith("\n")) lines.pop();
  const before: string[] = [];
  let cursor = 0;
  let last: "old" | "new" | "both" | null = null;
  let oldMissingNewline = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return null;
      // A hunk that adds nothing names the line before it; otherwise its first line.
      const start = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
      if (start < cursor || start > after.length) return null;
      before.push(...after.slice(cursor, start));
      cursor = start;
      last = null;
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === " " || mark === "+") {
      if (cursor >= after.length || after[cursor] !== text) return null;
      cursor++;
      if (mark === " ") before.push(text);
      last = mark === " " ? "both" : "new";
    } else if (mark === "-") {
      before.push(text);
      last = "old";
    } else if (mark === "\\") {
      // "\ No newline at end of file" qualifies the line before it.
      if (last === "old" || last === "both") oldMissingNewline = true;
    } else return null;
  }
  // A hunk that reaches the end of the file says how the old file ended; otherwise the
  // untouched tail ends the old file exactly as it ends the new one.
  const reachesEnd = lines.length > 0 && cursor === after.length;
  before.push(...after.slice(cursor));
  if (before.length === 0) return "";
  const newline = reachesEnd ? !oldMissingNewline : endsWithNewline;
  return before.join("\n") + (newline ? "\n" : "");
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const tooLarge = (size: number): Side => ({ kind: "limited", reason: "File exceeds the native review size limit", size });

/** Content loader for Orca's native diff, built only from endpoints CV Hub's web page already
 *  uses. The modified side is the file at the inspected head (`/blob/<headSha>/<path>`); the
 *  original side is that file with the PR's patch undone, which is the merge-base version even
 *  when the target branch has moved on. Failures become an `error` side for that file rather
 *  than an exception, so one missing blob never blanks the whole review. */
export async function readReviewFile(
  args: unknown,
  client: ReviewClient,
  diffs: DiffCache,
): Promise<{ original: Side; modified: Side }> {
  const { context, file } = z.object({ context: contextSchema, file: fileSchema }).parse(args);
  if (context.connectionId !== client.connectionId) {
    const stale = failed("connection_changed", "You signed in again since this review opened. Reopen it from the CV Hub panel.");
    return { original: stale, modified: stale };
  }
  let diff: PullDiff | null;
  try {
    diff = await diffs.get(context, client);
  } catch (error) {
    const side = failure(error);
    return { original: side, modified: side };
  }
  const entry = diff?.files.find((f) => f.path === file.path && f.oldPath === file.oldPath);
  if (!entry) return { original: STALE, modified: STALE };
  if (entry.binary)
    return {
      original: file.status === "added" ? { kind: "absent" } : { kind: "binary" },
      modified: file.status === "deleted" ? { kind: "absent" } : { kind: "binary" },
    };
  const modified: Side = file.status === "deleted" ? { kind: "absent" } : await loadBlob(client, context, file.path);
  if (file.status === "added") return { original: { kind: "absent" }, modified };
  if (entry.truncated)
    return { original: { kind: "limited", reason: "This file’s change is too large for CV Hub to send in full" }, modified };
  if (modified.kind !== "text" && modified.kind !== "absent") return { original: modified, modified };
  const original = reversePatch(modified.kind === "text" ? modified.content : "", entry.patch ?? "");
  if (original === null)
    return { original: failed("patch_mismatch", "CV Hub’s patch doesn’t match this file. Reopen the review to try again."), modified };
  const size = byteLength(original);
  return { original: size > SIDE_LIMIT ? tooLarge(size) : { kind: "text", content: original }, modified };
}

async function loadBlob(client: ReviewClient, context: Context, path: string): Promise<Side> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `/api/v1/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/blob/${context.headSha}/${encoded}`;
  try {
    const blob = blobSchema.parse(await client.json(url, 16 * 1024 * 1024));
    if (blob.isBinary) return { kind: "binary", ...(blob.size != null ? { size: blob.size } : {}) };
    const content = blob.content ?? "";
    const size = byteLength(content);
    return size > SIDE_LIMIT ? tooLarge(size) : { kind: "text", content };
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown): Side {
  const text = error instanceof Error ? error.message : "";
  if (text.startsWith("[not_found]")) return failed("not_found", "This file is unavailable at the reviewed revision.");
  if (text.startsWith("[forbidden]") || text.startsWith("[unauthorized]") || text.startsWith("[session_expired]"))
    return failed("unauthorized", "CV Hub refused access. Sign in again from the CV Hub panel.");
  if (text.startsWith("[too_large]")) return { kind: "limited", reason: "File exceeds the native review size limit" };
  return failed("unavailable", "CV Hub couldn’t load this file. Close and reopen the review to try again.");
}
