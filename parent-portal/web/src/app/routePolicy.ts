export type AppRole = "student" | "teacher" | "parent";

export type ThemeMode = "system" | "light" | "dark";

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface NavigationItem {
  readonly to: string;
  readonly label: string;
  readonly icon: string;
  readonly roles: readonly AppRole[];
  readonly group: "primary" | "secondary";
  readonly mobilePriority: number;
}

export interface RouteDefinition {
  readonly path: string;
  readonly roles: readonly AppRole[];
  readonly homeRedirect?: string;
}

export const HOME_BY_ROLE: Record<AppRole, string> = {
  student: "/today",
  teacher: "/dashboard",
  parent: "/guardian",
};

const STUDENT: readonly AppRole[] = ["student"];
const TEACHER: readonly AppRole[] = ["teacher"];
const CLASSROOM_ROLES: readonly AppRole[] = ["student", "teacher"];
const AUTHENTICATED: readonly AppRole[] = ["student", "teacher", "parent"];

export const NAVIGATION: Record<AppRole, readonly NavigationItem[]> = {
  student: [
    { to: "/today", label: "Today", icon: "home", roles: STUDENT, group: "primary", mobilePriority: 1 },
    { to: "/learn", label: "Learn", icon: "book", roles: STUDENT, group: "primary", mobilePriority: 2 },
    { to: "/classes", label: "Classes", icon: "classroom", roles: CLASSROOM_ROLES, group: "primary", mobilePriority: 3 },
    { to: "/discover", label: "Discover", icon: "spark", roles: STUDENT, group: "primary", mobilePriority: 4 },
    { to: "/progress", label: "Progress", icon: "trend", roles: STUDENT, group: "primary", mobilePriority: 5 },
  ],
  teacher: [
    { to: "/dashboard", label: "Command Center", icon: "dashboard", roles: TEACHER, group: "primary", mobilePriority: 1 },
    { to: "/review", label: "Review", icon: "check", roles: TEACHER, group: "primary", mobilePriority: 2 },
    { to: "/classes", label: "Classes", icon: "classroom", roles: CLASSROOM_ROLES, group: "primary", mobilePriority: 3 },
    { to: "/inbox", label: "Inbox", icon: "inbox", roles: TEACHER, group: "primary", mobilePriority: 4 },
    { to: "/calendar", label: "Calendar", icon: "calendar", roles: CLASSROOM_ROLES, group: "primary", mobilePriority: 5 },
    { to: "/library", label: "Library", icon: "library", roles: TEACHER, group: "secondary", mobilePriority: 6 },
    { to: "/academic-insights", label: "Academic insights", icon: "insights", roles: TEACHER, group: "secondary", mobilePriority: 7 },
    { to: "/interventions", label: "Interventions", icon: "intervention", roles: TEACHER, group: "secondary", mobilePriority: 8 },
  ],
  parent: [
    { to: "/guardian", label: "My children", icon: "family", roles: ["parent"], group: "primary", mobilePriority: 1 },
    { to: "/notifications", label: "Notifications", icon: "bell", roles: AUTHENTICATED, group: "secondary", mobilePriority: 2 },
    { to: "/settings", label: "Settings", icon: "settings", roles: AUTHENTICATED, group: "secondary", mobilePriority: 3 },
  ],
};

export const ROUTE_POLICY: readonly RouteDefinition[] = [
  ...["/today", "/learn", "/learn/:versionId", "/discover", "/progress", "/revision", "/assessment/:quizId"].map((path) => ({ path, roles: STUDENT })),
  ...["/dashboard", "/inbox", "/inbox/:insightId", "/interventions", "/academic-insights", "/review", "/library"].map((path) => ({ path, roles: TEACHER })),
  { path: "/guardian", roles: ["parent"] },
  ...["/classes", "/classes/:id", "/classes/:id/timeline", "/classes/:id/work/:cwId", "/calendar"].map((path) => ({ path, roles: CLASSROOM_ROLES })),
  { path: "/notifications", roles: AUTHENTICATED },
  { path: "/settings", roles: AUTHENTICATED },
];

function pathMatches(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

export function getRouteDefinition(pathname: string): RouteDefinition | undefined {
  return ROUTE_POLICY.find((route) => pathMatches(route.path, pathname));
}

export function canAccessRoute(role: AppRole, pathname: string): boolean {
  return getRouteDefinition(pathname)?.roles.includes(role) ?? false;
}

export function getNavigation(role: AppRole): readonly NavigationItem[] {
  return NAVIGATION[role];
}

export function getHomeForRole(role: AppRole): string {
  return HOME_BY_ROLE[role];
}
