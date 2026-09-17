import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import {
  getHomeForRole,
  ROUTE_POLICY,
  type AppRole,
} from "./app/routePolicy";
import AppShell from "./components/AppShell.jsx";
import { Loading } from "./components/ui";
import Login from "./pages/Login.jsx";

// Student portal: only routes reachable by the `student` role per
// app/routePolicy.ts's ROUTE_POLICY/CLASSROOM_ROLES/AUTHENTICATED sets are
// wired here. Teacher-only (/dashboard, /inbox, /inbox/:insightId,
// /interventions, /academic-insights, /review, /library) and parent-only
// (/guardian) routes — and their page components — were dropped in the
// split from roognis-product's monorepo web/ app. See README.md.
const Revision = lazy(() => import("./features/learning/Revision.jsx"));
const Assessment = lazy(() => import("./features/learning/Assessment.jsx"));
const Today = lazy(() => import("./features/learning/Today.jsx"));
const Learn = lazy(() => import("./features/learning/Learn.jsx"));
const Workspace = lazy(() => import("./features/learning/Workspace.jsx"));
const Discover = lazy(() => import("./features/learning/Discover.jsx"));
const Progress = lazy(() => import("./features/learning/Progress.jsx"));
const Settings = lazy(() => import("./features/learning/Settings.jsx"));
const ClassroomTimeline = lazy(() => import("./features/timeline/pages/ClassroomTimeline"));
const CalendarPage = lazy(() => import("./features/calendar/pages/CalendarPage"));
const NotificationsPage = lazy(() => import("./features/notifications/pages/NotificationsPage"));
const Classrooms = lazy(() => import("./pages/Classrooms.jsx"));
const Classroom = lazy(() => import("./pages/Classroom.jsx"));
const CourseworkDetail = lazy(() => import("./pages/CourseworkDetail.jsx"));

interface RoleGateProps {
  readonly role: AppRole;
  readonly roles: readonly AppRole[];
  readonly home: string;
  readonly children: JSX.Element;
}

function RoleGate({ role, roles, home, children }: RoleGateProps): JSX.Element {
  return roles.includes(role) ? children : <Navigate to={home} replace />;
}

/** Every authenticated route goes through the same policy before its page
 * component mounts. This keeps parent scope out of student and teacher data
 * loaders and makes the access matrix testable without rendering pages. */
function policyElement(path: string, role: AppRole, home: string, children: JSX.Element): JSX.Element {
  const policy = ROUTE_POLICY.find((definition) => definition.path === path);
  const roles = policy?.roles || [];
  return <RoleGate role={role} roles={roles} home={home}>{children}</RoleGate>;
}

export default function App(): JSX.Element {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="app-loading"><Loading label="Starting Roognis…" /></div>;
  }

  if (!user) {
    return <Routes><Route path="*" element={<Login />} /></Routes>;
  }

  const role = user.role;
  const home = getHomeForRole(role);

  return (
    <Suspense fallback={<div className="app-loading"><Loading label="Loading…" /></div>}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/today" element={policyElement("/today", role, home, <Today />)} />
          <Route path="/learn" element={policyElement("/learn", role, home, <Learn />)} />
          <Route path="/learn/:versionId" element={policyElement("/learn/:versionId", role, home, <Workspace />)} />
          <Route path="/discover" element={policyElement("/discover", role, home, <Discover />)} />
          <Route path="/progress" element={policyElement("/progress", role, home, <Progress />)} />
          <Route path="/revision" element={policyElement("/revision", role, home, <Revision />)} />
          <Route path="/assessment/:quizId" element={policyElement("/assessment/:quizId", role, home, <Assessment />)} />
          <Route path="/classes" element={policyElement("/classes", role, home, <Classrooms />)} />
          <Route path="/classes/:id" element={policyElement("/classes/:id", role, home, <Classroom />)} />
          <Route path="/classes/:id/timeline" element={policyElement("/classes/:id/timeline", role, home, <ClassroomTimeline />)} />
          <Route path="/classes/:id/work/:cwId" element={policyElement("/classes/:id/work/:cwId", role, home, <CourseworkDetail />)} />
          <Route path="/calendar" element={policyElement("/calendar", role, home, <CalendarPage />)} />
          <Route path="/notifications" element={policyElement("/notifications", role, home, <NotificationsPage />)} />
          <Route path="/settings" element={policyElement("/settings", role, home, <Settings />)} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
