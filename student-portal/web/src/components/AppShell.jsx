import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { relTime } from "../lib/format";
import { getHomeForRole, getNavigation } from "../app/routePolicy";
import { nextTheme } from "../app/theme";
import { applyAppearance, readAppearance, readTheme, saveTheme } from "../app/appearance";
import { getSurfaceKey, getViewpoint, useMotionPhase } from "../app/motion";
import { Avatar, Icon, Loading } from "./ui.jsx";
import {
  listNotifications,
  markAllNotificationsRead,
} from "../features/shared/services/lmsService";
import { QuickActionModal } from "../features/workflows/components/QuickActionModal.tsx";

const ROLE_LABELS = {
  student: "Student workspace",
  teacher: "Teacher workspace",
  parent: "Parent workspace",
};

function useTheme() {
  const [theme, setTheme] = useState(() =>
    readTheme(),
  );

  useEffect(() => {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    saveTheme(theme);
    applyAppearance(readAppearance());
  }, [theme]);

  useEffect(() => {
    const onThemeChange = (event) => {
      if (event.detail && event.detail !== theme) setTheme(event.detail);
    };
    window.addEventListener("roognis:theme-change", onThemeChange);
    return () => window.removeEventListener("roognis:theme-change", onThemeChange);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme !== "system") return;
      const resolved = media.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", resolved);
    };
    media.addEventListener?.("change", onSystemThemeChange);
    return () => media.removeEventListener?.("change", onSystemThemeChange);
  }, [theme]);

  function cycleTheme() {
    setTheme((current) => {
      const next = nextTheme(current);
      saveTheme(next);
      window.dispatchEvent(new CustomEvent("roognis:theme-change", { detail: next }));
      return next;
    });
  }

  return [theme, cycleTheme];
}

function NavigationLink({ item, onNavigate, menuItem = false }) {
  return (
    <NavLink
      to={item.to}
      end={item.to !== "/learn" && item.to !== "/classes"}
      onClick={onNavigate}
      role={menuItem ? "menuitem" : undefined}
      className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
    >
      <Icon name={item.icon} size={19} />
      <span>{item.label}</span>
    </NavLink>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [notificationError, setNotificationError] = useState(false);
  const hasLoadedNotifications = useRef(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const notificationPanelRef = useRef(null);

  const load = async () => {
    // Keep a successful list visible during interval refreshes; only the
    // initial empty request should occupy the popover with a loading state.
    setNotificationLoading(!hasLoadedNotifications.current);
    try {
      const data = await listNotifications(15);
      setItems(data.notifications || []);
      setUnread(data.unreadCount || 0);
      hasLoadedNotifications.current = true;
      setNotificationError(false);
    } catch {
      // Preserve the previous successful state during a transient poll error.
      setNotificationError(true);
    } finally {
      setNotificationLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDocumentMouseDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const panel = notificationPanelRef.current;
    window.requestAnimationFrame(() => panel?.focus());
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function markAll() {
    try {
      await markAllNotificationsRead();
      await load();
    } catch {
      setNotificationError(true);
    }
  }

  return (
    <div className="notification-wrap" ref={ref}>
      <button
        ref={triggerRef}
        className="btn btn-ghost btn-icon notification-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-label="Notifications"
        aria-expanded={open}
        aria-controls="notification-popover"
        aria-haspopup="dialog"
      >
        <Icon name="bell" size={19} />
        {unread > 0 ? (
          <span className="notification-count" aria-label={`${unread} unread notifications`}>
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={notificationPanelRef}
          id="notification-popover"
          className="notification-popover card"
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
        >
          <div className="notification-popover-head">
            <strong>Notifications</strong>
            {unread > 0 ? (
              <button className="btn btn-ghost btn-sm" onClick={markAll}>
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="notification-list">
            {notificationLoading ? (
              <div className="empty notification-empty" role="status">
                <Loading label="Loading notifications…" />
              </div>
            ) : notificationError && items.length === 0 ? (
              <div className="empty notification-empty">
                <Icon name="warning" size={24} />
                <span role="alert">Couldn&apos;t load notifications.</span>
                <button className="btn btn-outline btn-sm" onClick={load}>
                  Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="empty notification-empty">
                <Icon name="check" size={24} />
                <span>You&apos;re all caught up.</span>
              </div>
            ) : (
              <>
                {notificationError ? <p className="tiny muted" role="alert">Couldn&apos;t refresh notifications. Showing the last available list.</p> : null}
                {items.map((item) => (
                  <article
                    key={item.id}
                    className={`notification-item${item.isRead ? "" : " unread"}`}
                  >
                    <strong>{item.title}</strong>
                    {item.body ? <p>{item.body}</p> : null}
                    <time dateTime={item.createdAt || undefined}>
                      {relTime(item.createdAt)}
                    </time>
                  </article>
                ))}
              </>
            )}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="notification-see-all"
          >
            See all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function MobileMoreMenu({ items, onSignOut }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);
  if (!items.length && !onSignOut) return null;
  return (
    <div className="mobile-more-wrap">
      <button
        ref={triggerRef}
        className={`mobile-nav-item${open ? " active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="mobile-more-menu"
      >
        <Icon name="more" size={19} />
        <span>More</span>
      </button>
      {open ? (
        <div id="mobile-more-menu" className="mobile-more-menu" role="menu">
          {items.map((item) => (
            <NavigationLink key={item.to} item={item} menuItem onNavigate={() => setOpen(false)} />
          ))}
          {onSignOut ? (
            <button
              type="button"
              className="nav-link mobile-menu-action"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onSignOut();
              }}
            >
              <span aria-hidden="true">↪</span>
              <span>Sign out</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const [theme, cycleTheme] = useTheme();
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const role = user?.role || "student";
  const motionPhase = useMotionPhase(location.pathname, navigationType);
  const surfaceKey = getSurfaceKey(location.pathname);
  const viewpoint = getViewpoint(role);
  const navigation = getNavigation(role);
  const primary = navigation.filter((item) => item.group === "primary");
  const secondary = navigation.filter((item) => item.group === "secondary");
  const mobilePrimary =
    role === "teacher" || role === "student"
      ? primary.filter((item) => item.mobilePriority <= 4)
      : primary;
  const mobileMore =
    role === "teacher"
      ? [
          primary.find((item) => item.to === "/calendar"),
          ...secondary,
          { to: "/notifications", label: "Notifications", icon: "bell", roles: navigation[0]?.roles || [], group: "secondary", mobilePriority: 9 },
          { to: "/settings", label: "Settings", icon: "settings", roles: navigation[0]?.roles || [], group: "secondary", mobilePriority: 10 },
        ].filter(Boolean)
      : role === "student"
        ? [
            primary.find((item) => item.to === "/progress"),
            { to: "/notifications", label: "Notifications", icon: "bell", roles: navigation[0]?.roles || [], group: "secondary", mobilePriority: 9 },
            { to: "/settings", label: "Settings", icon: "settings", roles: navigation[0]?.roles || [], group: "secondary", mobilePriority: 10 },
          ].filter(Boolean)
        : [];

  async function signOut() {
    try {
      await logout();
    } catch {
      // AuthContext clears the local session in logout's finally block.
    }
    navigate("/login");
  }

  return (
    <div className={`app-shell role-${role}`} data-viewpoint={viewpoint} data-surface={surfaceKey}>
      <a href="#main" className="skip-link">Skip to main content</a>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <Link className="app-brand" to={getHomeForRole(role)}>
          <span className="app-brand-mark" aria-hidden="true">R</span>
          <span className="app-brand-copy">
            <strong>Roognis</strong>
            <span>{ROLE_LABELS[role]}</span>
          </span>
        </Link>
        <nav className="app-nav app-nav-primary" aria-label="Main">
          {primary.map((item) => <NavigationLink key={item.to} item={item} />)}
        </nav>
        {secondary.length ? (
          <div className="app-nav-secondary">
            <div className="app-nav-label">Workspace tools</div>
            <nav className="app-nav" aria-label="Workspace tools">
              {secondary.map((item) => <NavigationLink key={item.to} item={item} />)}
            </nav>
          </div>
        ) : null}
        <div className="grow" />
        <div className="app-sidebar-footer">Roognis · Learn with purpose</div>
      </aside>

      <div className="app-content">
        <div className="app-atmosphere" data-surface={surfaceKey} aria-hidden="true">
          <span className="atmosphere-orbit atmosphere-orbit-a" />
          <span className="atmosphere-orbit atmosphere-orbit-b" />
          <span className="atmosphere-node atmosphere-node-a" />
          <span className="atmosphere-node atmosphere-node-b" />
          <span className="atmosphere-node atmosphere-node-c" />
          <span className="atmosphere-line atmosphere-line-a" />
          <span className="atmosphere-line atmosphere-line-b" />
        </div>
        <header className="app-topbar">
          <div className="app-topbar-context">
            <span className="app-topbar-kicker">ROOGNIS</span>
            <span>{ROLE_LABELS[role]}</span>
          </div>
          <div className="app-topbar-actions">
            <button
              className="btn btn-ghost btn-icon theme-toggle"
              title={`Theme: ${theme}`}
              aria-label={`Theme: ${theme}. Change theme`}
              aria-pressed={theme === "dark"}
              onClick={cycleTheme}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            </button>
            <Link className="topbar-settings" to="/settings">Settings</Link>
            <NotificationBell />
            <span className="topbar-divider" aria-hidden="true" />
            <div className="account-menu">
              <Avatar name={user?.name} id={user?.userId} size="sm" />
              <div className="account-copy">
                <strong>{user?.name}</strong>
                <span>{role}</span>
              </div>
              <button
                className="btn btn-outline btn-sm sign-out"
                onClick={signOut}
              >
                Sign out
              </button>
            </div>
          </div>
        </header>
        <main
          id="main"
          className="app-main motion-page"
          data-motion-phase={motionPhase}
          data-route={location.pathname}
        >
          <Outlet />
        </main>
      </div>

      <nav className="app-mobile-nav" aria-label="Mobile navigation">
        {mobilePrimary.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to !== "/learn" && item.to !== "/classes"}
            className={({ isActive }) => `mobile-nav-item${isActive ? " active" : ""}`}
          >
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </NavLink>
        ))}
        <MobileMoreMenu items={mobileMore} onSignOut={signOut} />
        {role === "parent" ? (
          <>
            <NavLink to="/notifications" className={({ isActive }) => `mobile-nav-item${isActive ? " active" : ""}`}>
              <Icon name="bell" size={19} /><span>Notifications</span>
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => `mobile-nav-item${isActive ? " active" : ""}`}>
              <Icon name="settings" size={19} /><span>Settings</span>
            </NavLink>
          </>
        ) : null}
      </nav>
      <QuickActionModal />
    </div>
  );
}
