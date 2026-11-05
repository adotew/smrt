const LATEST_RELEASE = "https://api.github.com/repos/adotew/smrt/releases/latest";

/** Compares dotted versions such as "v1.10.0" and "1.9.2"; a leading "v" is ignored. */
export function isNewer(latest: string, current: string) {
  const parts = (version: string) => version.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/** The latest GitHub release if it is newer than `current`, or null; nothing released yet counts as up to date. */
export async function newerRelease(current: string) {
  const response = await fetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered with status ${response.status}.`);
  const release = (await response.json()) as { tag_name: string; html_url: string };
  return isNewer(release.tag_name, current) ? { version: release.tag_name.replace(/^v/, ""), url: release.html_url } : null;
}
