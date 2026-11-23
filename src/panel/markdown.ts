import DOMPurify from "dompurify";
import { Marked } from "marked";
import { openExternal } from "./bridge";

/** GitHub-flavored Markdown for PR descriptions and review bodies, the way CV Hub shows them.
 *  `marked` parses; DOMPurify then keeps only formatting tags, so author-written HTML can't
 *  run script, load anything or restyle the panel. Raw HTML in the source is shown as text. */
const parser = new Marked({ gfm: true, breaks: false, async: false });
parser.use({
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

const ALLOWED_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s",
  "code", "pre", "blockquote", "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td",
  "input", "span", "sup", "sub", "kbd",
];
const ALLOWED_ATTR = ["href", "title", "align", "type", "checked", "disabled", "start"];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only web and mail links leave the panel, through Orca's browser prompt. */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function markdown(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "md";
  if (!DOMPurify.isSupported) {
    // No sanitizer here: show the source as text rather than unsanitized HTML.
    const pre = document.createElement("p");
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = source;
    root.append(pre);
    return root;
  }
  const html = parser.parse(source, { async: false }) as string;
  root.append(
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    }),
  );
  for (const box of root.querySelectorAll("input")) {
    if (box.type !== "checkbox") box.remove();
    else box.disabled = true;
  }
  for (const a of root.querySelectorAll("a")) {
    const href = safeHref(a.getAttribute("href"));
    a.removeAttribute("href");
    if (!href) {
      a.replaceWith(...a.childNodes);
      continue;
    }
    a.className = "mdlink";
    a.title = href;
    a.tabIndex = 0;
    a.setAttribute("role", "link");
    const open = (event: Event) => {
      event.preventDefault();
      void openExternal(href);
    };
    a.addEventListener("click", open);
    a.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") open(event);
    });
  }
  return root;
}
