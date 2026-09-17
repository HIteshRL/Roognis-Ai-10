import { useEffect, useRef, useState } from "react";
export function useResource(loader, dependencies = []) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [revision, setRevision] = useState(0);
  const previousDependencies = useRef(dependencies);
  const identityChanged = dependencies.length !== previousDependencies.current.length
    || dependencies.some((value, index) => value !== previousDependencies.current[index]);
  previousDependencies.current = dependencies;
  useEffect(() => {
    let active = true;
    setState((current) => ({
      loading: identityChanged || current.data === null,
      refreshing: !identityChanged && current.data !== null,
      data: identityChanged ? null : current.data,
      error: "",
    }));
    loader()
      .then((data) => active && setState({ loading: false, refreshing: false, data, error: "" }))
      .catch(
        (error) =>
          active &&
          setState((current) => ({
            loading: false,
            refreshing: false,
            data: current.data,
            error: error.message,
          })),
      );
    return () => {
      active = false;
    };
  }, [...dependencies, revision]);
  return { ...state, reload: () => setRevision((n) => n + 1) };
}
export function PageHeading({ eyebrow, title, description, children }) {
  return (
    <header className="learning-heading">
      <div>
        <p className="learning-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {children}
    </header>
  );
}
export function ResourceState({ resource, empty, children }) {
  if (resource.loading && !resource.data)
    return (
      <div className="learning-empty" role="status">
        Loading your workspace…
      </div>
    );
  if (resource.error && !resource.data)
    return (
      <div className="learning-empty" role="alert">
        <h3>We couldn’t load this</h3>
        <p>{resource.error}</p>
        <button className="btn btn-outline" onClick={resource.reload}>
          Try again
        </button>
      </div>
    );
  if (empty)
    return (
      <div className="learning-empty">
        <h3>Ready when you are</h3>
        <p>{empty}</p>
      </div>
    );
  return (
    <div className="resource-content" aria-busy={resource.refreshing || undefined}>
      {resource.error ? <p className="learning-refresh-error" role="alert">We couldn’t refresh this view. Showing the last available result.</p> : null}
      {children}
    </div>
  );
}
export function ErrorNotice({ message }) {
  return message ? (
    <p className="learning-error" role="alert">
      {message}
    </p>
  ) : null;
}
