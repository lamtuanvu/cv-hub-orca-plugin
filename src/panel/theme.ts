/** Follow Orca's theme. Main bakes the current `--orca-*` variables and the `light`/`dark`
 *  class into every document the frame serves, and the `theme` event keeps them current
 *  without a reload; we only mirror the scheme onto the panel root for the few colors Orca
 *  does not hand frames (diff hues, status colors). */
import type { Disposable } from "orca/host";

export function watchTheme(root: HTMLElement, onChange: () => void): Disposable {
  const apply = (scheme: string) => {
    if (root.dataset.theme !== scheme) {
      root.dataset.theme = scheme;
      onChange();
    }
  };
  apply(document.documentElement.classList.contains("dark") ? "dark" : "light");
  return orca.on("theme", ({ colorScheme }) => apply(colorScheme));
}
