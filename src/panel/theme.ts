/** Follow Orca's theme: the host injects CSS variables (--background, …) into the panel.
 *  We read the luminance of Orca's background and switch CV Hub's own token set. */
function luminance(color: string): number | null {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  if (!rgb || rgb.length < 3) return null;
  const [r, g, b] = rgb.slice(0, 3).map((v) => Number(v) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function watchTheme(root: HTMLElement, onChange: () => void) {
  const apply = () => {
    const hostBg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
    const lum = hostBg ? luminance(hostBg) : null;
    const dark = lum === null ? matchMedia("(prefers-color-scheme: dark)").matches : lum < 0.5;
    const next = dark ? "dark" : "light";
    if (root.dataset.theme !== next) {
      root.dataset.theme = next;
      onChange();
    }
  };
  apply();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme"],
  });
}
