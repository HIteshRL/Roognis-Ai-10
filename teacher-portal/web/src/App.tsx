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

// Teacher-portal extraction: only the routes a `teacher` can reach under
// ROUTE_POLICY (routePolicy.ts) are wired here — TEACHER-only routes plus the
// CLASSROOM_ROLES (student+teacher) and AUTHENTICATED (all roles) routes.
// Student-only surfaces (Today/Learn/Workspace/Discover/Progress/Revision/
// Assessment) and the parent-only Guardian page are intentionally not
// imported: their source files were not copied into this repo, so importing
// them here would break the build. See README.md for the full split
// rationale.
const AcademicInsights = lazy(() => import("./features/learning/AcademicInsights.jsx"));
const Review = lazy(() => import("./features/learning/Review.jsx"));
const Library = lazy(() => import("./features/learning/Library.jsx"));
const Settings = lazy(() => import("./features/learning/Settings.jsx"));
const TeacherDashboard = lazy(() => import("./features/dashboard/pages/TeacherDashboard"));
const ClassroomTimeline = lazy(() => import("./features/timeline/pages/ClassroomTimeline"));
const AIInbox = lazy(() => import("./features/ai-inbox/pages/AIInbox"));
const InsightDetails = lazy(() => import("./features/ai-inbox/pages/InsightDetails"));
const StudentIntervention = lazy(() => import("./features/interventions/pages/StudentIntervention"));
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
          <Route path="/dashboard" element={policyElement("/dashboard", role, home, <TeacherDashboard />)} />
          <Route path="/inbox" element={policyElement("/inbox", role, home, <AIInbox />)} />
          <Route path="/inbox/:insightId" element={policyElement("/inbox/:insightId", role, home, <InsightDetails />)} />
          <Route path="/interventions" element={policyElement("/interventions", role, home, <StudentIntervention />)} />
          <Route path="/academic-insights" element={policyElement("/academic-insights", role, home, <AcademicInsights />)} />
          <Route path="/review" element={policyElement("/review", role, home, <Review />)} />
          <Route path="/library" element={policyElement("/library", role, home, <Library />)} />
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
