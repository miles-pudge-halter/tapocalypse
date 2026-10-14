import type { Route } from "./hooks";

/** Identity of the page: filter edits on the Runs page must not count as navigation (no scroll reset, no remount). */
export function pageKey(route: Route, hub: boolean): string {
  switch (route.name) {
    case "run":
    case "batch":
      return `${route.name}:${route.id}`;
    case "compare":
      return `compare:${route.id}:${route.baselineId}`;
    case "reports":
      return `reports:${route.projectId}`;
    case "flaky":
      return `flaky:${route.projectId}`;
    case "report":
      return `report:${route.projectId}:${route.reportName}`;
    // The ref and the show filter are filter edits on the same page, not navigation.
    case "overview":
      return `overview:${route.projectId}`;
    case "releases":
      return `releases:${route.projectId}`;
    case "release":
      return `release:${route.projectId}:${route.ref.kind}:${route.ref.name}`;
    // A laptop's home is the runs page: `#/` and `#/runs?...` are the same page.
    case "home":
      return hub ? "home" : "runs";
    default:
      return route.name;
  }
}
