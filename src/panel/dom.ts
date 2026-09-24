export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

/** Tiny DOM builder. `on*` keys attach listeners, booleans toggle attributes, `value` and
 *  `checked` set properties, everything else becomes a string attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function")
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === "value" || key === "checked")
      (el as unknown as Record<string, unknown>)[key] = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}
export function append(el: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}
export function add(el: Node, ...children: Child[]) {
  append(el, children);
}
/** Buttons in Orca's sandbox must never submit a form. */
export function button(attrs: Attrs, ...children: Child[]) {
  return h("button", { type: "button", ...attrs }, ...children);
}
