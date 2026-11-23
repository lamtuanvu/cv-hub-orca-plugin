import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " line one",
  "-line two",
  "+line two changed",
  "+line two and a half",
  " line three",
  "\\ No newline at end of file",
  "@@ -10,1 +11,1 @@ somewhere",
  "-old",
  "+new",
].join("\n");

describe("the unified patch parser", () => {
  it("skips the file prologue and numbers both sides", () => {
    const rows = parsePatch(patch);
    // The prologue (diff/index/---/+++) never becomes a row.
    expect(rows.map((r) => r.kind)).toEqual([
      "hunk",
      "context",
      "del",
      "add",
      "add",
      "context",
      "meta",
      "hunk",
      "del",
      "add",
    ]);
    const hunk = rows.indexOf(rows.find((r) => r.kind === "hunk")!);
    expect(hunk).toBe(0);
    const context = rows[1];
    expect(context).toMatchObject({ kind: "context", oldLine: 1, newLine: 1, text: "line one" });
    expect(rows[2]).toMatchObject({ kind: "del", oldLine: 2, newLine: null, text: "line two" });
    expect(rows[3]).toMatchObject({ kind: "add", oldLine: null, newLine: 2, text: "line two changed" });
    expect(rows[4]).toMatchObject({ kind: "add", oldLine: null, newLine: 3 });
    expect(rows[5]).toMatchObject({ kind: "context", oldLine: 3, newLine: 4, text: "line three" });
    expect(rows[6]).toMatchObject({ kind: "meta", text: "No newline at end of file" });
    // The second hunk restarts numbering from its own header.
    expect(rows[8]).toMatchObject({ kind: "del", oldLine: 10 });
    expect(rows[9]).toMatchObject({ kind: "add", newLine: 11 });
  });

  it("handles a new file's -0,0 header and drops stray trailing newlines", () => {
    const rows = parsePatch("@@ -0,0 +1,2 @@\n+first\n+second\n");
    expect(rows).toEqual([
      { kind: "hunk", header: "@@ -0,0 +1,2 @@" },
      { kind: "add", oldLine: null, newLine: 1, text: "first" },
      { kind: "add", oldLine: null, newLine: 2, text: "second" },
    ]);
  });

  it("returns nothing for a patch without hunks", () => {
    expect(parsePatch("diff --git a/x b/x\nindex 1..2 100644\n")).toEqual([]);
  });
});
