/**
 * Guesses app routes from changed Next.js app-router files, for the preview
 * hint. Route groups and dynamic segments are dropped, since their values are
 * not known here.
 */
export function routesFromFiles(paths: readonly string[]): string[] {
  const routes = new Set<string>();
  for (const path of paths) {
    const index = path.indexOf("/app/");
    if (index === -1 || !/\.(tsx|ts|jsx|js|mdx)$/.test(path)) continue;
    const segments = path.slice(index + "/app/".length).split("/");
    segments.pop();
    const route = segments
      .filter((segment) => !/^\(.*\)$/.test(segment) && !/^\[.*\]$/.test(segment) && !segment.startsWith("_") && !segment.startsWith("@"))
      .join("/");
    routes.add(`/${route}`);
  }
  return [...routes].sort().slice(0, 12);
}
