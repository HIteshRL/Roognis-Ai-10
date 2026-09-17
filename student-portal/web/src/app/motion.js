import { useEffect, useRef, useState } from "react";

export const MOTION_TIMINGS = Object.freeze({
  fast: 220,
  surface: 420,
  slow: 600,
});

export const MOTION_EASING = "cubic-bezier(0, 0, .2, 1)";

export function getViewpoint(role) {
  return role === "parent" ? "guardian" : role;
}

/**
 * Returns a stable, visual-only subject family for the current route. The
 * value is deliberately deterministic: it can shape an atmosphere without
 * creating a new random scene or storing any product data.
 */
export function getSurfaceKey(pathname = "") {
  const path = pathname.toLowerCase();
  if (path.includes("discover")) return "discovery";
  if (path.includes("learn") || path.includes("assessment") || path.includes("revision")) return "learning";
  if (path.includes("guardian")) return "family";
  if (path.includes("dashboard") || path.includes("inbox") || path.includes("intervention") || path.includes("review")) return "operations";
  if (path.includes("class") || path.includes("calendar")) return "classroom";
  if (path.includes("settings") || path.includes("notification")) return "preferences";
  return "today";
}

/**
 * Drives the smallest possible route transition state. Content remains
 * mounted, so data loaders and focus ownership are not coupled to animation.
 */
export function useMotionPhase(pathname, navigationType = "PUSH") {
  const previousPath = useRef(pathname);
  const [phase, setPhase] = useState("static");

  useEffect(() => {
    const changed = previousPath.current !== pathname;
    previousPath.current = pathname;
    // A restored history entry should feel stable. Forward navigation gets a
    // bounded settle; POP navigation never replays decorative travel.
    if (navigationType === "POP") {
      setPhase("static");
      return undefined;
    }
    setPhase(changed ? "replace" : "enter");

    const frame = window.requestAnimationFrame(() => setPhase("enter"));
    const timer = window.setTimeout(() => setPhase("ready"), MOTION_TIMINGS.surface);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [pathname, navigationType]);

  return phase;
}
