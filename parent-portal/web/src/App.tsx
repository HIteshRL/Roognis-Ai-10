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

// Parent-portal extraction: this app only ever serves role === "parent", so
// only the three routes a parent can reach under ROUTE_POLICY are wired up
// here — /guardian, /notifications, /settings (the last two are shared with
// student/teacher in the original monorepo's ROUTE_POLICY, which is kept
// unmodified below so the access matrix stays testable and in sync with the
// monorepo's). Every other page (Today, Learn, Classrooms, TeacherDashboard,
// AIInbox, interventions, calendar, timeline, etc.) was student/teacher-only
// per canAccessRoute() and was not extracted into this repo.
const Settings = lazy(() => import("./features/learning/Settings.jsx"));
const NotificationsPage = lazy(() => import("./features/notifications/pages/NotificationsPage"));
const Guardian = lazy(() => import("./pages/Guardian.jsx"));

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
          <Route path="/guardian" element={policyElement("/guardian", role, home, <Guardian />)} />
          <Route path="/notifications" element={policyElement("/notifications", role, home, <NotificationsPage />)} />
          <Route path="/settings" element={policyElement("/settings", role, home, <Settings />)} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
