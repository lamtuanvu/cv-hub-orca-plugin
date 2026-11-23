/** The in-panel diff: parses one file's unified patch (the same text CV Hub's own web page
 *  renders) and draws it with hunk headers, old/new line numbers and add/delete coloring,
 *  unified or split. The panel theme's tokens (see style.css) supply the colors. */
import { h, type Child } from "./dom";
import type { DiffFileView } from "../shared/protocol";

export type DiffRow =
  | { kind: "hunk"; header: string }
  | { kind: "context" | "add" | "del"; oldLine: number | null; newLine: number | null; text: string }
  | { kind: "meta"; text: string };

/** Skips the file prologue (`diff --git`, `index`, `rename from/to`, `---`/`+++`) and walks
 *  the hunks, numbering lines the way a unified diff numbers them. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = patch.split("\n");
  // The text ends with a newline: the empty string after it is not a line.
  if (lines.at(-1) === "") lines.pop();
  let oldLine = 0;
  let newLine = 0;
  let inHunks = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      inHunks = true;
      rows.push({ kind: "hunk", header: line });
      continue;
    }
    if (!inHunks) continue; // prologue or stray text before the first hunk
    const tag = line[0] ?? "";
    const text = line.slice(1);
    if (tag === "+") rows.push({ kind: "add", oldLine: null, newLine: newLine++, text });
    else if (tag === "-") rows.push({ kind: "del", oldLine: oldLine++, newLine: null, text });
    else if (tag === " ") rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
    else if (tag === "\\") rows.push({ kind: "meta", text: text.replace(/^ /, "") });
    else if (line === "") rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: "" });
  }
  return rows;
}

const lineCell = (value: number | null) => h("td", { class: "ln" }, value === null ? "" : String(value));

/** One file's patch, drawn the way the toggle selects: unified (two gutters, one text
 *  column) or split (old and new side by side, change runs paired up). */
export function renderPatch(patch: string, split: boolean): HTMLElement {
  const table = h("table", { class: `difft ${split ? "split" : "unified"}` });
  const body = h("tbody");
  table.appendChild(body);
  const rows = parsePatch(patch);
  if (!split) {
    for (const row of rows) {
      if (row.kind === "hunk")
        body.appendChild(h("tr", { class: "dhunk" }, h("td", { colspan: "3" }, row.header)));
      else if (row.kind === "meta") body.appendChild(h("tr", { class: "dmeta" }, h("td", { colspan: "3" }, row.text)));
      else
        body.appendChild(
          h("tr", { class: `d${row.kind}` }, lineCell(row.oldLine), lineCell(row.newLine), h("td", { class: "dl" }, row.text)),
        );
    }
    return table;
  }
  // Split: within each hunk, a run of deletions pairs with the run of additions after it.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === "hunk") {
      body.appendChild(h("tr", { class: "dhunk" }, h("td", { colspan: "4" }, row.header)));
      continue;
    }
    if (row.kind === "meta") {
      body.appendChild(h("tr", { class: "dmeta" }, h("td", { colspan: "4" }, row.text)));
      continue;
    }
    if (row.kind === "del") {
      // A deletion run pairs with the addition run right after it.
      const dels: (typeof rows)[number][] = [];
      const adds: (typeof rows)[number][] = [];
      let j = i;
      while (j < rows.length && rows[j].kind === "del") dels.push(rows[j++]);
      while (j < rows.length && rows[j].kind === "add") adds.push(rows[j++]);
      i = j - 1;
      const width = Math.max(dels.length, adds.length);
      for (let k = 0; k < width; k++) {
        const del = dels[k];
        const add = adds[k];
        body.appendChild(
          h(
            "tr",
            { class: "dchange" },
            lineCell(del && del.kind === "del" ? del.oldLine : null),
            h("td", { class: `dl ${del ? "rm" : "gap"}` }, del && del.kind === "del" ? del.text : ""),
            lineCell(add && add.kind === "add" ? add.newLine : null),
            h("td", { class: `dl ${add ? "ins" : "gap"}` }, add && add.kind === "add" ? add.text : ""),
          ),
        );
      }
      continue;
    }
    if (row.kind === "add") {
      // An addition run with no deletions before it.
      const adds: (typeof rows)[number][] = [];
      let j = i;
      while (j < rows.length && rows[j].kind === "add") adds.push(rows[j++]);
      i = j - 1;
      for (const add of adds)
        body.appendChild(
          h(
            "tr",
            { class: "dchange" },
            lineCell(null),
            h("td", { class: "dl gap" }, ""),
            lineCell(add.kind === "add" ? add.newLine : null),
            h("td", { class: "dl ins" }, add.kind === "add" ? add.text : ""),
          ),
        );
      continue;
    }
    // Context: the same line on both sides.
    body.appendChild(
      h(
        "tr",
        { class: "dcontext" },
        lineCell(row.oldLine),
        h("td", { class: "dl" }, row.text),
        lineCell(row.newLine),
        h("td", { class: "dl" }, row.text),
      ),
    );
  }
  return table;
}

export const STATUS_LABEL: Record<DiffFileView["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
};

/** A changed file's one-line summary: status chip, path (old → new when renamed) and the
 *  add/delete counts. */
export function fileSummary(file: DiffFileView): Child[] {
  return [
    h("span", { class: `fstat st-${file.status}`, title: STATUS_LABEL[file.status] }, STATUS_LABEL[file.status].slice(0, 3)),
    h(
      "span",
      { class: "fpath mono trunc" },
      file.status === "renamed" && file.oldPath && file.oldPath !== file.path
        ? [file.oldPath, " → ", file.path]
        : file.path,
    ),
  ];
}
