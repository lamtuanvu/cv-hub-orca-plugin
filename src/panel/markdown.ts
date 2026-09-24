import { h, type Child } from "./dom";

/** Safe Markdown subset built as DOM nodes — never innerHTML. Links render as text plus their
 *  address: the sandboxed panel cannot navigate, and nothing here pretends it can. */
function inline(text: string): Child[] {
  const out: Child[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) out.push(h("code", null, token.slice(1, -1)));
    else if (m[2]) out.push(h("strong", null, token.slice(2, -2)));
    else {
      const label = token.slice(1, token.indexOf("]"));
      const href = token.slice(token.indexOf("(") + 1, -1);
      out.push(h("span", { class: "mdlink", title: href }, label), h("span", { class: "mut xs" }, ` (${href})`));
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function markdown(source: string): HTMLElement {
  const root = h("div", { class: "md" });
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) root.append(h("p", null, inline(para.join(" "))));
    para = [];
  };
  const flushList = () => {
    if (list) root.append(h(list.ordered ? "ol" : "ul", null, list.items.map((i) => h("li", null, inline(i)))));
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      root.append(h("pre", null, h("code", null, code.join("\n"))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      root.append(h("h4", null, inline(heading[2])));
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return root;
}
