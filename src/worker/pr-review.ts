import { z } from "zod";
import { contextSchema, fileSchema, sideSchema, pullPath } from "../shared/contracts";

type Side = z.infer<typeof sideSchema>;
const failed = (code: string, message: string): Side => ({ kind: "error", code, message });
/** Content loader for Orca's native diff. The original side always comes from the merge base
 *  (at the old path for renames) and the modified side from the inspected head, both named by
 *  immutable SHAs in the snapshot context. Failures become an `error` side for that file
 *  rather than an exception, so one missing blob never blanks the whole review. */
export async function readReviewFile(
  args: unknown,
  client: { connectionId: string; json(path: string): Promise<unknown> },
): Promise<{ original: Side; modified: Side }> {
  const { context, file } = z.object({ context: contextSchema, file: fileSchema }).parse(args);
  if (context.connectionId !== client.connectionId) {
    const stale = failed("connection_changed", "You signed in again since this review opened. Reopen it from the CV Hub panel.");
    return { original: stale, modified: stale };
  }
  const load = async (sha: string, path: string): Promise<Side> => {
    try {
      const side = sideSchema.parse(
        await client.json(`${pullPath(context)}/review-file?${new URLSearchParams({ sha, path })}`),
      );
      return side.kind === "text" ? { kind: "text", content: side.content } : side;
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      if (text.startsWith("[not_found]")) return failed("not_found", "This file is unavailable at the reviewed revision.");
      if (text.startsWith("[forbidden]") || text.startsWith("[unauthorized]") || text.startsWith("[session_expired]"))
        return failed("unauthorized", "CV Hub refused access. Sign in again from the CV Hub panel.");
      if (text.startsWith("[too_large]")) return { kind: "limited", reason: "File exceeds the native review size limit" };
      return failed("unavailable", "CV Hub couldn’t load this file. Close and reopen the review to try again.");
    }
  };
  const [original, modified] = await Promise.all([
    file.status === "added" ? ({ kind: "absent" } as const) : load(context.mergeBaseSha, file.oldPath ?? file.path),
    file.status === "deleted" ? ({ kind: "absent" } as const) : load(context.headSha, file.path),
  ]);
  return { original, modified };
}
