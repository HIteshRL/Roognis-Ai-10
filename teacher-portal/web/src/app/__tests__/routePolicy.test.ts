import { describe, expect, it } from "vitest";
import {
  canAccessRoute,
  getHomeForRole,
  getNavigation,
  getRouteDefinition,
} from "../routePolicy";

describe("role route policy", () => {
  it("keeps the three role homes stable", () => {
    expect(getHomeForRole("student")).toBe("/today");
    expect(getHomeForRole("teacher")).toBe("/dashboard");
    expect(getHomeForRole("parent")).toBe("/guardian");
  });

  it("isolates private student, teacher and parent routes", () => {
    expect(canAccessRoute("parent", "/discover")).toBe(false);
    expect(canAccessRoute("student", "/dashboard")).toBe(false);
    expect(canAccessRoute("teacher", "/guardian")).toBe(false);
    expect(canAccessRoute("parent", "/unknown-private-route")).toBe(false);
    expect(canAccessRoute("parent", "/classes/one/work/two")).toBe(false);
    expect(canAccessRoute("student", "/classes/one/work/two")).toBe(true);
    expect(canAccessRoute("teacher", "/classes/one/timeline")).toBe(true);
    expect(canAccessRoute("parent", "/notifications")).toBe(true);
  });

  it("matches parameterized routes without granting unknown paths", () => {
    expect(getRouteDefinition("/learn/chapter-1")?.path).toBe("/learn/:versionId");
    expect(getRouteDefinition("/inbox/insight-1")?.path).toBe("/inbox/:insightId");
    expect(getRouteDefinition("/not-a-route")).toBeUndefined();
  });

  it("uses labelled role-specific navigation with predictable mobile priorities", () => {
    const student = getNavigation("student");
    const teacher = getNavigation("teacher");
    const parent = getNavigation("parent");
    expect(student.map((item) => item.label)).toEqual(["Today", "Learn", "Classes", "Discover", "Progress"]);
    expect(teacher.filter((item) => item.group === "primary").map((item) => item.label)).toEqual(["Command Center", "Review", "Classes", "Inbox", "Calendar"]);
    expect(teacher.filter((item) => item.mobilePriority <= 4)).toHaveLength(4);
    expect(parent.map((item) => item.label)).toEqual(["My children", "Notifications", "Settings"]);
    expect(student.every((item) => item.label && item.icon)).toBe(true);
  });
});
