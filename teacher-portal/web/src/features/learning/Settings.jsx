import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
import { useToast } from "../../components/ui.jsx";
import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  normaliseHex,
  readAppearance,
  readTheme,
  saveAppearance,
  saveTheme,
} from "../../app/appearance";
async function graphql(query, variables = {}) {
  const response = await api.post("/discover/graphql", { query, variables });
  if (response.errors?.length) throw new Error(response.errors[0].message);
  return response.data;
}
function Preferences() {
  const resource = useResource(() =>
      graphql(
        "{ myPreferences { topicId label stance muted } preferenceCollectionEnabled }",
      ),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reset, setReset] = useState(false);
  async function mutate(query, variables) {
    setBusy(true);
    setError("");
    try {
      await graphql(query, variables);
      resource.reload();
      setReset(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="learning-panel">
      <h2>Your discovery preferences</h2>
      <p>
        These interests personalise Discover. They are separate from assessment
        evidence and grades.
      </p>
      <ErrorNotice message={error} />
      <ResourceState resource={resource}>
        <label className="learning-option">
          <input
            type="checkbox"
            disabled={busy}
            checked={!!resource.data?.preferenceCollectionEnabled}
            onChange={(e) =>
              mutate(
                "mutation($enabled:Boolean!){setPreferenceCollectionEnabled(enabled:$enabled)}",
                { enabled: e.target.checked },
              )
            }
          />{" "}
          Allow preference collection
        </label>
        {resource.data?.myPreferences?.map((p) => (
          <div className="learning-list-row" key={p.topicId}>
            <span>
              {p.label} ·{" "}
              {p.stance === "LIKE" ? "Interested" : "Less interested"}
              {p.muted ? " · Muted" : ""}
            </span>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() =>
                mutate(
                  "mutation($id:ID!){deletePreference(topicId:$id){deleted}}",
                  { id: p.topicId },
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        {!resource.data?.myPreferences?.length && (
          <p className="muted">No preferences saved yet.</p>
        )}
        {!reset ? (
          <button className="btn btn-outline" onClick={() => setReset(true)}>
            Reset discovery profile
          </button>
        ) : (
          <div role="alert">
            <p>
              This deletes your discovery preference profile. Your coursework
              and grades remain available.
            </p>
            <button
              className="btn btn-outline"
              disabled={busy}
              onClick={() =>
                mutate("mutation{deleteMyPreferenceProfile{deleted}}")
              }
            >
              Delete profile
            </button>
            <button className="btn btn-ghost" onClick={() => setReset(false)}>
              Cancel
            </button>
          </div>
        )}
      </ResourceState>
    </section>
  );
}

const THEME_CHOICES = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

const ACCENT_PRESETS = [
  { key: "custom", label: "Custom", value: "" },
  { key: "ochre", label: "Ochre", value: "#BD711D" },
  { key: "coral", label: "Coral", value: "#D6533E" },
  { key: "teal", label: "Teal", value: "#347D6B" },
  { key: "berry", label: "Berry", value: "#A13C5F" },
];

function applyThemeChoice(choice) {
  if (typeof document === "undefined") return;
  const isDark = choice === "dark"
    || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

function AppearanceSettings() {
  const [theme, setTheme] = useState(readTheme);
  const [appearance, setAppearance] = useState(readAppearance);
  const importInputRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    applyThemeChoice(theme);
    applyAppearance(appearance);
  }, [theme, appearance]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme === "system") applyThemeChoice("system");
    };
    media.addEventListener?.("change", onSystemThemeChange);
    return () => media.removeEventListener?.("change", onSystemThemeChange);
  }, [theme]);

  function chooseTheme(nextTheme) {
    setTheme(nextTheme);
    saveTheme(nextTheme);
    applyThemeChoice(nextTheme);
    window.dispatchEvent(new CustomEvent("roognis:theme-change", { detail: nextTheme }));
  }

  function updateAppearance(patch) {
    setAppearance((current) => {
      const next = { ...current, ...patch };
      saveAppearance(next);
      applyAppearance(next);
      return next;
    });
  }

  function chooseAccentPreset(event) {
    const preset = ACCENT_PRESETS.find((item) => item.key === event.target.value) || ACCENT_PRESETS[0];
    updateAppearance({ accent: preset.value, accentPreset: preset.key });
  }

  async function copyTheme() {
    const payload = JSON.stringify({ theme, appearance }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      toast?.success("Appearance copied to the clipboard.");
    } catch {
      toast?.error("Couldn’t copy appearance on this device.");
    }
  }

  function importTheme(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    file.text().then((contents) => {
      const parsed = JSON.parse(contents);
      const importedTheme = ["system", "light", "dark"].includes(parsed?.theme)
        ? parsed.theme
        : "system";
      const importedAppearance = parsed?.appearance && typeof parsed.appearance === "object"
        ? { ...DEFAULT_APPEARANCE, ...parsed.appearance }
        : { ...DEFAULT_APPEARANCE };
      setTheme(importedTheme);
      saveTheme(importedTheme);
      setAppearance(importedAppearance);
      saveAppearance(importedAppearance);
      applyThemeChoice(importedTheme);
      applyAppearance(importedAppearance);
      window.dispatchEvent(new CustomEvent("roognis:theme-change", { detail: importedTheme }));
      toast?.success("Appearance imported.");
    }).catch(() => {
      toast?.error("That file is not a valid Roognis appearance.");
    });
  }

  const selectedPreset = ACCENT_PRESETS.some((item) => item.key === appearance.accentPreset)
    ? appearance.accentPreset
    : "custom";
  const accentValue = normaliseHex(appearance.accent) || "#C4965F";
  const backgroundValue = normaliseHex(appearance.background) || "#F9F7F3";
  const foregroundValue = normaliseHex(appearance.foreground) || "#1A2D47";

  return (
    <section className="learning-panel appearance-settings" aria-labelledby="appearance-settings-title">
      <div className="appearance-settings-heading">
        <div>
          <h2 id="appearance-settings-title">Appearance</h2>
          <p className="muted">Tune the workspace for your device, reading style, and focus.</p>
        </div>
        <div className="appearance-settings-actions">
          <input ref={importInputRef} className="appearance-file-input" type="file" accept="application/json,.json" onChange={importTheme} aria-label="Import appearance file" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => importInputRef.current?.click()}>Import theme</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyTheme}>Copy theme</button>
        </div>
      </div>

      <div className="appearance-setting-group">
        <div>
          <span className="appearance-setting-label">Theme</span>
          <p className="appearance-setting-note">System follows your device. Your choice is saved on this device.</p>
        </div>
        <div className="appearance-theme-grid" role="radiogroup" aria-label="Theme">
          {THEME_CHOICES.map((choice) => (
            <button
              key={choice.key}
              type="button"
              className={`appearance-theme-card${theme === choice.key ? " selected" : ""}`}
              role="radio"
              aria-checked={theme === choice.key}
              onClick={() => chooseTheme(choice.key)}
            >
              <span className={`appearance-theme-preview preview-${choice.key}`} aria-hidden="true"><i /><b /></span>
              <span>{choice.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-setting-group">
        <span className="appearance-setting-label">Customise</span>
        <div className="appearance-setting-rows">
          <div className="appearance-setting-row">
            <label htmlFor="react-accent-preset">Accent</label>
            <div className="appearance-setting-control appearance-accent-control">
              <select id="react-accent-preset" className="select" value={selectedPreset} onChange={chooseAccentPreset}>
                {ACCENT_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
              </select>
              <label className="appearance-color-chip" htmlFor="react-appearance-accent">
                <input id="react-appearance-accent" type="color" value={accentValue} aria-label="Custom accent colour" onChange={(event) => updateAppearance({ accent: event.target.value.toUpperCase(), accentPreset: "custom" })} />
                <span className="appearance-color-swatch" style={{ "--swatch": accentValue }} aria-hidden="true" />
                <span>{normaliseHex(appearance.accent) || "Default"}</span>
              </label>
            </div>
          </div>
          <div className="appearance-setting-row">
            <label htmlFor="react-appearance-background">Background</label>
            <label className="appearance-setting-control appearance-color-chip" htmlFor="react-appearance-background">
              <input id="react-appearance-background" type="color" value={backgroundValue} aria-label="Background colour" onChange={(event) => updateAppearance({ background: event.target.value.toUpperCase() })} />
              <span className="appearance-color-swatch" style={{ "--swatch": backgroundValue }} aria-hidden="true" />
              <span>{normaliseHex(appearance.background) || "Default"}</span>
            </label>
          </div>
          <div className="appearance-setting-row">
            <label htmlFor="react-appearance-foreground">Foreground</label>
            <label className="appearance-setting-control appearance-color-chip" htmlFor="react-appearance-foreground">
              <input id="react-appearance-foreground" type="color" value={foregroundValue} aria-label="Foreground colour" onChange={(event) => updateAppearance({ foreground: event.target.value.toUpperCase() })} />
              <span className="appearance-color-swatch" style={{ "--swatch": foregroundValue }} aria-hidden="true" />
              <span>{normaliseHex(appearance.foreground) || "Default"}</span>
            </label>
          </div>
          <div className="appearance-setting-row">
            <label htmlFor="react-ui-font">UI font</label>
            <div className="appearance-setting-control">
              <select id="react-ui-font" className="select" value={appearance.uiFont} onChange={(event) => updateAppearance({ uiFont: event.target.value })}>
                <option value="system">System UI (default)</option>
                <option value="source">Source Sans</option>
                <option value="rounded">Rounded system</option>
              </select>
            </div>
          </div>
          <div className="appearance-setting-row">
            <label htmlFor="react-content-font">Content font</label>
            <div className="appearance-setting-control">
              <select id="react-content-font" className="select" value={appearance.contentFont} onChange={(event) => updateAppearance({ contentFont: event.target.value })}>
                <option value="system">System UI (default)</option>
                <option value="source">Source Sans</option>
                <option value="serif">Reading serif</option>
              </select>
            </div>
          </div>
          <div className="appearance-setting-row">
            <span id="react-sidebar-label">Translucent sidebar</span>
            <label className="appearance-switch">
              <input type="checkbox" role="switch" aria-labelledby="react-sidebar-label" checked={Boolean(appearance.translucentSidebar)} onChange={(event) => updateAppearance({ translucentSidebar: event.target.checked })} />
              <span aria-hidden="true" />
            </label>
          </div>
          <div className="appearance-setting-row">
            <label htmlFor="react-contrast">Contrast</label>
            <div className="appearance-contrast-control">
              <input id="react-contrast" type="range" min="0" max="100" value={Number(appearance.contrast) || 0} onChange={(event) => updateAppearance({ contrast: Number(event.target.value) })} />
              <output htmlFor="react-contrast">{Number(appearance.contrast) || 0}</output>
            </div>
          </div>
        </div>
      </div>

      <button type="button" className="btn btn-ghost appearance-reset" onClick={() => {
        const next = { ...DEFAULT_APPEARANCE };
        setAppearance(next);
        saveAppearance(next);
        applyAppearance(next);
      }}>Reset appearance</button>
    </section>
  );
}

export default function Settings() {
  const { user } = useAuth();
  return (
    <>
      <PageHeading
        eyebrow="ACCOUNT & PREFERENCES"
        title="Make this space yours."
        description="Manage your learning preferences and account context."
      />
      <section className="learning-panel">
        <h2>{user.name}</h2>
        <p className="muted">{user.role} account</p>
      </section>
      <AppearanceSettings />
      {user.role === "student" && <Preferences />}
    </>
  );
}
