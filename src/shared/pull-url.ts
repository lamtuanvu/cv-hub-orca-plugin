/** CV Hub deploys its web app beside the api. host, or on the same origin. */
export function pullWebUrl(origin: string, pull: { owner: string; repo: string; number: number }, webOrigin?: string | null): string {
  const url = new URL(webOrigin ?? origin);
  if (!webOrigin) url.hostname = url.hostname.replace(/^api\./, "");
  url.pathname = `/dashboard/repositories/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/pulls/${pull.number}`;
  url.search = "";
  url.hash = "";
  return url.href;
}
