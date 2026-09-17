import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { colorFor, initials } from "../lib/format";

const ICON_PATHS = {
  home: "M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-9ZM9 21v-6h6v6",
  dashboard: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  book: "M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5v-17ZM5 19.5A2.5 2.5 0 0 1 7.5 17H20M9 6h7M9 9h7",
  classroom: "M3 20h18M5 20V8l7-4 7 4v12M9 20v-5h6v5M8 10h.01M12 10h.01M16 10h.01",
  spark: "m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z",
  trend: "M4 17 9 12l4 3 7-8M15 7h5v5",
  check: "m5 12 4 4L19 6",
  inbox: "M4 5h16v14H4zM4 14h4l1.5 2h5L16 14h4M8 9h8",
  calendar: "M5 4v3M19 4v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12H4V7a1 1 0 0 1 1-1ZM8 13h3M8 16h3M14 13h3",
  library: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM4 19.5A2.5 2.5 0 0 1 6.5 17H20M9 7h7M9 10h7",
  insights: "M5 20V10M12 20V4M19 20v-7M3 20h18",
  intervention: "M12 4 21 20H3L12 4ZM12 10v4M12 17h.01",
  family: "M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM16 11a3 3 0 1 0 0-6M17 15.2a3.5 3.5 0 0 1 3 3.3V20",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.5V20a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H7.3v-2.5h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2H16v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2V14h-.2a1.7 1.7 0 0 0-1.6 1Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  moon: "M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5Z",
  sun: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z",
  warning: "M12 4 21 20H3L12 4ZM12 10v4M12 17h.01",
  close: "m6 6 12 12M18 6 6 18",
  arrow: "M5 12h13M13 6l6 6-6 6",
};

export function Icon({ name, size = 20, label }) {
  const path = ICON_PATHS[name] || ICON_PATHS.spark;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

export function Avatar({ name, id, size = "md" }) {
  const cls = size === "sm" ? "avatar avatar-sm" : size === "lg" ? "avatar avatar-lg" : "avatar";
  return (
    <span className={cls} style={{ background: colorFor(id || name) }} title={name}>
      {initials(name)}
    </span>
  );
}

const BADGE_TONES = {
  default: "",
  neutral: "",
  primary: "badge-primary",
  info: "badge-info",
  success: "badge-success",
  warn: "badge-warn",
  warning: "badge-warn",
  danger: "badge-danger",
};

export function Badge({ children, tone = "default", dot = false }) {
  const toneClass = BADGE_TONES[tone] || "";
  return <span className={`badge ${toneClass} ${dot ? "badge-dot" : ""}`}>{children}</span>;
}

export function StatusBadge({ tone = "neutral", label, icon }) {
  return (
    <Badge tone={tone} dot={!icon}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {label}
    </Badge>
  );
}

export function Spinner({ size = 20 }) {
  return <span className="spinner" style={{ "--spinner-size": `${size}px` }} aria-hidden="true" />;
}

export function Loading({ label = "Loading…" }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function LoadingState({ label = "Loading…" }) {
  return <Loading label={label} />;
}

export function EmptyState({ icon = "inbox", title, hint, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">{typeof icon === "string" && ICON_PATHS[icon] ? <Icon name={icon} size={24} /> : icon}</div>
      <h2 className="empty-title">{title}</h2>
      {hint ? <div className="small empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, children }) {
  return (
    <header className="ui-page-header">
      <div>
        {eyebrow ? <p className="ui-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="ui-page-description">{description}</p> : null}
      </div>
      {children ? <div className="ui-page-actions">{children}</div> : null}
    </header>
  );
}

export function Surface({ as: Element = "section", className = "", children }) {
  return <Element className={`surface ${className}`}>{children}</Element>;
}

export function Metric({ label, value, hint, tone = "neutral" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

export function ActionCard({ eyebrow, title, description, action, tone = "default", children }) {
  return (
    <article className={`action-card action-card-${tone}`}>
      {eyebrow ? <span className="ui-eyebrow">{eyebrow}</span> : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="action-card-action">{action}</div> : null}
      {children}
    </article>
  );
}

export function ListRow({ as: Element = "div", className = "", children, ...props }) {
  return <Element className={`list-row ${className}`} {...props}>{children}</Element>;
}

export function ErrorNotice({ message, children }) {
  if (!message && !children) return null;
  return <div className="error-notice" role="alert">{children || message}</div>;
}

function useDialogFocus(open, onClose, dialogRef) {
  const restoreRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const selector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
    const focusables = () => [...(dialog?.querySelectorAll(selector) || [])];
    const first = focusables()[0];
    window.requestAnimationFrame(() => (first || dialog)?.focus());
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (!nodes.length) return;
      const current = document.activeElement;
      const index = nodes.indexOf(current);
      if (event.shiftKey && (index <= 0 || current === dialog)) {
        event.preventDefault();
        nodes[nodes.length - 1].focus();
      } else if (!event.shiftKey && index === nodes.length - 1) {
        event.preventDefault();
        nodes[0].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreRef.current?.focus) restoreRef.current.focus();
    };
  }, [open, dialogRef]);
}

export function Modal({ open, onClose, title, children, footer, wide }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useDialogFocus(open, onClose, dialogRef);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div ref={dialogRef} className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer, wide = false }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useDialogFocus(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <aside ref={panelRef} className={`drawer-panel${wide ? " drawer-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="drawer-head"><h2 id={titleId}>{title}</h2><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={18} /></button></div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>
  );
}

export function FocusRing({ children }) {
  return <span className="focus-ring-wrapper">{children}</span>;
}

export function MobileActionBar({ children }) {
  return <div className="mobile-action-bar">{children}</div>;
}

const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, tone = "default") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, msg, tone }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3800);
  }, []);
  const toast = {
    show: (message) => push(message, "default"),
    success: (message) => push(message, "success"),
    error: (message) => push(message, "error"),
  };
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-host" aria-live="polite" aria-atomic="true">
        {toasts.map((item) => <div key={item.id} className={`toast ${item.tone}`}>{item.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

if (typeof document !== "undefined" && !document.getElementById("spin-kf")) {
  const style = document.createElement("style");
  style.textContent = "@keyframes spin { to { transform: rotate(360deg) } }";
  style.id = "spin-kf";
  document.head.appendChild(style);
}
