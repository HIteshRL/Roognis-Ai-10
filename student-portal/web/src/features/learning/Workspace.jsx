import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { learningApi, streamTutor, waitForResult } from "./client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
import Onboarding from "./Onboarding";
import StudyVisual from "./StudyVisual";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function createTutorRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error("This browser cannot create a secure Tutor request. Refresh and try again.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ChapterPdfReader({ chapter, targetPage, onAsk, onPageChange, studentId }) {
  const canvas = useRef(null), stage = useRef(null), pdf = useRef(null), renderTask = useRef(null), generation = useRef(0);
  const [page, setPage] = useState(1), [pages, setPages] = useState(0), [scale, setScale] = useState(1.15), [fitMode, setFitMode] = useState("custom");
  const [status, setStatus] = useState("Loading your published chapter…"), [suggestions, setSuggestions] = useState([]), [suggestionStatus, setSuggestionStatus] = useState("");
  const [search, setSearch] = useState(""), [searchStatus, setSearchStatus] = useState(""), [showThumbnails, setShowThumbnails] = useState(false);
  const suggestionCache = useRef(new Map());
  const storageKey = `roognis.classroom.reader.${studentId || "student"}.${chapter.documentId}`;

  useEffect(() => {
    let active = true;
    generation.current += 1;
    const readSaved = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
        return {
          page: Math.max(1, Number(saved.page) || 1),
          scale: Math.min(2.8, Math.max(.55, Number(saved.scale) || 1.15)),
          fitMode: ["width", "page", "custom"].includes(saved.fitMode) ? saved.fitMode : "custom",
        };
      } catch { return { page: 1, scale: 1.15, fitMode: "custom" }; }
    };
    const saved = readSaved();
    setPage(saved.page); setScale(saved.scale); setFitMode(saved.fitMode); setSuggestions([]); setSuggestionStatus(""); setSearchStatus("");
    const task = pdfjsLib.getDocument({ url: `/api/rag/documents/${chapter.documentId}/file`, withCredentials: true });
    task.promise.then(value => {
      if (!active) return value.destroy();
      pdf.current = value; setPages(value.numPages); setPage(valuePage => Math.min(value.numPages, valuePage)); setStatus("");
    }).catch(() => active && setStatus("This PDF is unavailable or is not published to your classroom."));
    return () => { active = false; generation.current += 1; renderTask.current?.cancel(); task.destroy(); pdf.current = null; setPages(0); };
  }, [chapter.documentId, storageKey]);

  useEffect(() => { if (targetPage > 0) setPage(Math.min(pages || targetPage, targetPage)); }, [targetPage, pages]);

  useEffect(() => { if (pages) onPageChange?.(page); }, [onPageChange, page, pages]);

  useEffect(() => {
    if (!pdf.current || !canvas.current) return;
    let active = true;
    const renderGeneration = ++generation.current;
    const currentPdf = pdf.current;
    renderTask.current?.cancel();
    currentPdf.getPage(page).then(pdfPage => {
      if (!active || renderGeneration !== generation.current || currentPdf !== pdf.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(260, (stage.current?.clientWidth || base.width + 32) - 32);
      const availableHeight = Math.max(320, (stage.current?.clientHeight || base.height + 32) - 32);
      const effectiveScale = fitMode === "width" ? Math.min(2.8, Math.max(.55, availableWidth / base.width))
        : fitMode === "page" ? Math.min(2.8, Math.max(.55, Math.min(availableWidth / base.width, availableHeight / base.height))) : scale;
      const viewport = pdfPage.getViewport({ scale: effectiveScale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2), node = canvas.current;
      node.width = Math.floor(viewport.width * ratio); node.height = Math.floor(viewport.height * ratio);
      node.style.width = `${Math.floor(viewport.width)}px`; node.style.height = `${Math.floor(viewport.height)}px`;
      renderTask.current = pdfPage.render({ canvasContext: node.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      return renderTask.current.promise.then(() => {
        if (active && renderGeneration === generation.current && currentPdf === pdf.current) {
          setScale(effectiveScale);
          try { localStorage.setItem(storageKey, JSON.stringify({ page, scale: effectiveScale, fitMode })); } catch { /* optional local progress */ }
        }
      });
    }).catch(error => { if (error?.name !== "RenderingCancelledException") setStatus("This PDF page could not be rendered."); });
    return () => { active = false; renderTask.current?.cancel(); };
  }, [chapter.documentId, page, scale, fitMode, pages, storageKey]);

  useEffect(() => {
    if (!pages) return;
    const controller = new AbortController(), requestGeneration = generation.current;
    const cacheKey = `${chapter.documentId}:${page}`;
    const cached = suggestionCache.current.get(cacheKey);
    setSuggestions(cached || []); setSuggestionStatus(cached ? "" : "Preparing questions for this page…");
    if (cached) return () => controller.abort();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/ai/reader/suggestions", {
          method: "POST", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: chapter.documentId, page }),
        });
        if (!response.ok) { const error = new Error("Suggestions unavailable"); error.status = response.status; throw error; }
        const payload = await response.json();
        if (!controller.signal.aborted && requestGeneration === generation.current) { suggestionCache.current.set(cacheKey, payload.suggestions || []); setSuggestions(payload.suggestions || []); setSuggestionStatus(""); }
      } catch (error) {
        if (!controller.signal.aborted && requestGeneration === generation.current && ![401, 403, 404].includes(error.status)) { setSuggestions([
          { id: "explain", text: `Explain the main idea on page ${page}.` },
          { id: "summarise", text: `Summarise page ${page} in simple words.` },
          { id: "quiz", text: `Quiz me on page ${page}.` },
        ]); setSuggestionStatus("Provider fallback prompts"); }
        else if (!controller.signal.aborted && requestGeneration === generation.current) setSuggestionStatus("Page suggestions are unavailable for this chapter.");
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [chapter.documentId, page, pages]);

  async function searchCurrentPage(event) {
    event?.preventDefault();
    const term = search.trim().toLowerCase();
    if (!term || !pdf.current) { setSearchStatus("Enter a word to search this page."); return; }
    try {
      const content = await pdf.current.getPage(page).then((value) => value.getTextContent());
      const found = content.items.map((item) => item.str || "").join(" ").toLowerCase().includes(term);
      setSearchStatus(found ? `Found on page ${page}` : "No match on this page");
    } catch { setSearchStatus("Search is unavailable while the page is loading."); }
  }

  return <section className="chapter-pdf-reader" ref={stage} onKeyDown={(event) => {
    if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); setPage(value => Math.max(1, value - 1)); }
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); setPage(value => Math.min(pages || 1, value + 1)); }
  }}>
    <div className="chapter-pdf-toolbar" role="toolbar" aria-label="PDF reader controls">
      <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
      <label>Page <input type="number" min="1" max={pages || 1} value={page} onChange={event => setPage(Math.max(1, Math.min(pages || 1, Number(event.target.value) || 1)))} /> / {pages || "—"}</label>
      <button className="btn btn-outline" disabled={!pages || page >= pages} onClick={() => setPage(value => value + 1)}>Next</button>
      <button className="btn btn-outline" onClick={() => setScale(value => Math.max(.55, value - .15))}>−</button>
      <button className="btn btn-outline" onClick={() => setScale(value => Math.min(2.8, value + .15))}>+</button>
      <button className="btn btn-outline" onClick={() => setFitMode("width")}>Fit width</button>
      <button className="btn btn-outline" onClick={() => setFitMode("page")}>Fit page</button>
      <button className="btn btn-outline" onClick={() => setShowThumbnails(value => !value)} aria-expanded={showThumbnails}>Thumbnails</button>
      <button className="btn btn-outline" onClick={() => stage.current?.requestFullscreen?.()}>Fullscreen</button>
      <button className="btn btn-primary" onClick={() => onAsk("", { useCurrentPage: true })}>Ask Tutor</button>
    </div>
    <form className="chapter-pdf-search" onSubmit={searchCurrentPage}><label htmlFor="chapter-pdf-search">Search this page</label><input id="chapter-pdf-search" value={search} onChange={event => setSearch(event.target.value)} /><button className="btn btn-outline">Search</button><span role="status">{searchStatus}</span></form>
    {showThumbnails ? <nav id="chapter-pdf-thumbnails" className="chapter-pdf-thumbnails" aria-label="PDF pages">{Array.from({ length: pages }, (_, index) => <button key={index + 1} className="btn btn-outline" aria-current={page === index + 1 ? "page" : undefined} onClick={() => setPage(index + 1)}>Page {index + 1}</button>)}</nav> : null}
    <div className="chapter-pdf-stage" tabIndex="0" role="img" aria-label={`PDF page ${page} of ${pages || "unknown"}`}>{status ? <p>{status}</p> : null}<canvas ref={canvas} /><span className="sr-only">Use the arrow keys to change pages.</span></div>
    <div className="chapter-pdf-suggestions"><span>Ask about this page:</span>{suggestionStatus ? <small>{suggestionStatus}</small> : null}{suggestions.map(item => <button key={item.id} onClick={() => onAsk(item.text, { useCurrentPage: true })}>{item.text}</button>)}</div>
  </section>;
}

function Tutor({ chapter, initialQuestion = "", onSourcePage, readerPage, useCurrentPage, onUseCurrentPageChange }) {
  const onboarding = useResource(() => api.get("/ai/onboarding"));
  const [messages, setMessages] = useState([]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [guided, setGuided] = useState(true),
    [inferenceStatus, setInferenceStatus] = useState(""),
    [historyLoading, setHistoryLoading] = useState(true);
  const session = useRef(null),
    controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (initialQuestion) setText(initialQuestion); }, [initialQuestion]);
  useEffect(() => {
    let active = true;
    setMessages([]); session.current = null; setHistoryLoading(true);
    api.get("/ai/chat/sessions?limit=100").then(async (payload) => {
      const match = (payload.sessions || []).find((item) =>
        item.subject === chapter.context?.subject && Number(item.grade) === Number(chapter.context?.grade)
        && Number(item.chapterNumber) === Number(chapter.context?.chapterNumber)
        && (!item.chapterName || !chapter.context?.chapterName || item.chapterName === chapter.context.chapterName));
      if (!match) return;
      const history = await api.get(`/ai/chat/${match.sessionId}/history`);
      if (!active) return;
      session.current = match.sessionId;
      setMessages(history.map((item) => ({ role: item.role === "user" ? "student" : "tutor", text: item.content, sources: [], vision: null })));
    }).catch(() => { /* history is optional; a new session remains usable */ })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; controller.current?.abort(); };
  }, [chapter.id]);
  async function send(e) {
    e.preventDefault();
    if (busy || historyLoading || !text.trim()) return;
    setBusy(true);
    setError("");
    setInferenceStatus("");
    const message = text.trim();
    setText("");
    setMessages((m) => [
      ...m,
      { role: "student", text: message },
      { role: "tutor", text: "" },
    ]);
    controller.current = new AbortController();
    try {
      if (!session.current)
        session.current = (
          await api.post("/ai/chat/session", {
            ...chapter.context,
            documentId: chapter.documentId,
          })
        ).sessionId;
      await streamTutor(
        {
          sessionId: session.current,
          requestId: createTutorRequestId(),
          message,
          mode: guided ? "guided" : "normal",
          ...(readerPage ? { readerContext: { page: readerPage, usePage: Boolean(useCurrentPage) } } : {}),
        },
        ({ event, data }) => {
          if (event === "inference_status") setInferenceStatus(data?.message || "");
          if (event === "answer_context") setMessages((m) => m.map((v, i) => i === m.length - 1 ? { ...v, sources: data?.excerpts || [], vision: data?.vision || null } : v));
          if (event === "token" && data?.text)
            setMessages((m) =>
              m.map((v, i) =>
                i === m.length - 1 ? { ...v, text: v.text + data.text } : v,
              ),
            );
        },
        controller.current.signal,
      );
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message);
        setMessages((m) => m.length && m[m.length - 1]?.role === "tutor" && !m[m.length - 1].text ? m.slice(0, -1) : m);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResourceState resource={onboarding}>
      {onboarding.data?.required ? (
        <Onboarding initial={onboarding.data} onComplete={onboarding.reload} />
      ) : (
        <section className="learning-panel tutor-panel">
          <div className="spread">
            <h2>Your chapter tutor</h2>
            <label>
              <input
                type="checkbox"
                checked={guided}
                onChange={(e) => setGuided(e.target.checked)}
              />{" "}
              Guide me with hints
            </label>
          </div>
          <label className="learning-option">
            <input
              type="checkbox"
              checked={Boolean(useCurrentPage && readerPage)}
              disabled={!readerPage}
              onChange={(event) => onUseCurrentPageChange?.(event.target.checked)}
            />{" "}
            {readerPage ? `Use page ${readerPage} for diagrams, figures, and tables` : "Open a PDF page to use page context"}
          </label>
          <div className="tutor-messages">
            {!messages.length && (
              <div className="learning-empty">
                <span className="tutor-spark">✦</span>
                <h3>Questions are where understanding begins.</h3>
                <p>
                  Ask about {chapter.title.toLowerCase()}, or request an
                  example.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div className={`tutor-message ${m.role}`} key={i}>
                <small>{m.role === "student" ? "You" : "Roognis Tutor"}</small>
                <p>
                  {m.text || (busy ? "Thinking…" : "Response interrupted.")}
                </p>
                {m.role === "tutor" && m.sources?.length > 0 ? <details><summary>Sources from your chapter</summary>{m.sources.map((s) => <blockquote key={s.index}><strong>{s.source}</strong><p>{s.text}</p>{Number(s.pageStart) > 0 ? <button className="btn btn-outline" onClick={() => onSourcePage?.(s.pageStart)}>Go to page {s.pageStart}</button> : null}</blockquote>)}</details> : null}
                {m.role === "tutor" && m.vision?.status === "used" && Number(m.vision.sourcePage) > 0 ? <div className="learning-option"><span>Visual source: page {m.vision.sourcePage}</span> <button className="btn btn-outline" type="button" onClick={() => onSourcePage?.(m.vision.sourcePage)}>Go to page {m.vision.sourcePage}</button></div> : null}
              </div>
            ))}
          </div>
          <ErrorNotice message={error} />
          {inferenceStatus ? <p className="tiny muted" role="status" aria-live="polite">{inferenceStatus}</p> : null}
          <form className="tutor-composer" onSubmit={send}>
            <label className="sr-only" htmlFor="tutor-message">
              Ask your tutor
            </label>
            <textarea
              id="tutor-message"
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Help me understand…"
              disabled={busy || historyLoading}
              required
            />
            <button className="btn btn-primary" disabled={busy || historyLoading}>
              {historyLoading ? "Loading history…" : busy ? "Thinking…" : "Send ↑"}
            </button>
          </form>
          <p className="tiny muted">
            AI explanations may contain mistakes. Check the chapter source when
            something is unclear.
          </p>
        </section>
      )}
    </ResourceState>
  );
}
function Practice({ chapter }) {
  const [set, setSet] = useState(null),
    [answers, setAnswers] = useState({}),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    const active = controller.current;
    return () => active.abort();
  }, []);
  async function start() {
    setBusy(true);
    setError("");
    try {
      const job = await api.post("/practice", {
        documentId: chapter.documentId,
      });
      setSet(
        await waitForResult(`/practice/${job.practiceSetId}`, {
          signal: controller.current.signal,
        }),
      );
      setResult(null);
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(
        (
          await api.post(`/practice/${set.practiceSetId}/attempt`, {
            answers,
            flashcardsReviewed: reviewed,
          })
        ).result,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="learning-panel">
      <span className="learning-pill">SELF-STUDY · UNGRADED</span>
      <h2>A little practice goes a long way.</h2>
      <ErrorNotice message={error} />
      {!set ? (
        <>
          <p>
            Build a summary, flashcards, and practice questions from this
            chapter.
          </p>
          <button className="btn btn-primary" disabled={busy} onClick={start}>
            {busy ? "Preparing your practice…" : "Prepare practice"}
          </button>
        </>
      ) : (
        <>
          <h3>Chapter summary</h3>
          <p className="learning-prose">
            {typeof set.summary === "string"
              ? set.summary
              : set.summary?.body || set.summary?.overview || set.summary?.text}
          </p>
          <h3>Flashcards</h3>
          <div className="learning-cards">
            {set.flashcards?.map((card, i) => (
              <details className="learning-flashcard" key={card.id || i}>
                <summary>{card.front || card.question}</summary>
                <p>{card.back || card.answer}</p>
              </details>
            ))}
          </div>
          <label className="learning-option">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />{" "}
            I have reviewed these flashcards
          </label>
          <form onSubmit={submit}>
            {set.quiz?.map((q, i) => (
              <fieldset className="learning-question" key={q.id}>
                <legend>
                  {i + 1}. {q.prompt}
                </legend>
                {(Array.isArray(q.options)
                  ? q.options
                  : Object.entries(q.options || {}).map(([id, text]) => ({
                      id,
                      text,
                    }))
                ).map((o, j) => {
                  const value = typeof o === "string" ? o : o.id || o.label;
                  return (
                    <label className="learning-option" key={value}>
                      <input
                        type="radio"
                        required
                        name={q.id}
                        value={value}
                        checked={answers[q.id] === value}
                        onChange={() =>
                          setAnswers({ ...answers, [q.id]: value })
                        }
                      />
                      {typeof o === "string" ? o : o.text || o.label}
                    </label>
                  );
                })}
              </fieldset>
            ))}
            <button className="btn btn-primary" disabled={busy || !!result}>
              Check my answers
            </button>
          </form>
          {result && (
            <div role="status">
              <h3>Your practice result</h3>
              <p>
                {result.score} / {result.maxScore}
              </p>
              {result.results?.map((r, i) => (
                <p key={i}>{r.explanation}</p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
function Visuals({ chapter }) {
  const [prompt, setPrompt] = useState(""),
    [kind, setKind] = useState("concept_map"),
    [visual, setVisual] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    const active = controller.current;
    return () => active.abort();
  }, []);
  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const job = await api.post(
        kind === "image" ? "/ai/image" : "/ai/visuals",
        { documentId: chapter.documentId, prompt, kind },
      );
      setVisual(
        await waitForResult(
          kind === "image"
            ? `/ai/image/${job.jobId}/status`
            : `/ai/visuals/${job.artifactId}`,
          { signal: controller.current.signal },
        ),
      );
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="learning-panel">
      <h2>See the idea take shape.</h2>
      <form className="learning-form" onSubmit={create}>
        <label>
          Visual format
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="concept_map">Concept map</option>
            <option value="explainer">Interactive explainer</option>
            <option value="image">Illustration</option>
          </select>
        </label>
        <label>
          What would you like to understand?
          <textarea
            required
            maxLength={500}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Explain a concept from ${chapter.title}`}
          />
        </label>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Creating your visual…" : "Create visual"}
        </button>
      </form>
      <ErrorNotice message={error} />
      {visual && (
        <>
          <p>{visual.altText}</p>
          {visual.imageUrl ? (
            <img
              className="learning-visual"
              alt={prompt}
              src={visual.imageUrl}
            />
          ) : visual.svg ? (
            <img
              className="learning-visual"
              alt={visual.altText || "Concept map"}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(visual.svg)}`}
            />
          ) : visual.html ? (
            <iframe
              className="learning-visual"
              title={visual.altText || "Interactive explanation"}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={visual.html}
            />
          ) : (
            <p>The visual could not be displayed.</p>
          )}
        </>
      )}
    </section>
  );
}
export default function Workspace() {
  const { user } = useAuth(), { versionId } = useParams(),
    [searchParams, setSearchParams] = useSearchParams(),
    resource = useResource(learningApi.catalog),
    [tab, setTab] = useState("learn"),
    [visited, setVisited] = useState({}),
    [tutorOpen, setTutorOpen] = useState(false),
    [suggestedQuestion, setSuggestedQuestion] = useState(""),
    [sourcePage, setSourcePage] = useState(0),
    [readerPage, setReaderPage] = useState(0),
    [tutorUseCurrentPage, setTutorUseCurrentPage] = useState(false);
  const tutorCloseRef = useRef(null);
  const tutorDrawerRef = useRef(null);
  const chapter = resource.data?.items?.find((x) => x.id === versionId);
  const requestedTool = searchParams.get("tool");
  useEffect(() => {
    const close = event => {
      if (!tutorOpen) return;
      if (event.key === "Escape") { event.preventDefault(); setTutorOpen(false); document.querySelector("#tab-tutor")?.focus(); return; }
      if (event.key !== "Tab") return;
      const drawer = document.querySelector(".classroom-tutor-drawer");
      const focusable = drawer ? [...drawer.querySelectorAll("button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")].filter((node) => !node.hidden && node.offsetParent !== null) : [];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [tutorOpen]);
  useEffect(() => {
    if (!tutorOpen) return;
    const timer = setTimeout(() => tutorCloseRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [tutorOpen]);
  useEffect(() => {
    if (tutorDrawerRef.current) tutorDrawerRef.current.inert = !tutorOpen;
  }, [tutorOpen]);
  function openTutor(question = "", options = {}) {
    setTab("learn");
    setSuggestedQuestion(question);
    if (options.useCurrentPage) setTutorUseCurrentPage(true);
    setVisited(value => ({ ...value, tutor: true }));
    setTutorOpen(true);
  }
  function activateTab(nextTab) {
    setTab(nextTab);
    setTutorOpen(false);
    setVisited((value) => ({ ...value, [nextTab]: true }));
  }
  function handleTabKeyDown(event, index) {
    const tabs = ["learn", "practice", "visuals"];
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    document.querySelector(`#tab-${nextTab}`)?.focus();
    activateTab(nextTab);
  }
  useEffect(() => {
    if (!chapter || !["tutor", "practice"].includes(requestedTool)) return;
    if (requestedTool === "tutor") openTutor();
    else activateTab("practice");
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("tool");
    setSearchParams(nextParams, { replace: true });
  }, [chapter?.id, requestedTool]);
  return (
    <ResourceState
      resource={resource}
      empty={
        !resource.loading && !resource.error && !chapter
          ? "This chapter is no longer available. Return to your learning library."
          : null
      }
    >
      {chapter && (
        <>
          <Link to="/learn">← Learning library</Link>
          <PageHeading
            eyebrow={chapter.context?.subject}
            title={chapter.title}
            description="Your source material, tutor, and practice in one place."
          />
          <StudyVisual chapter={chapter} />
          <div className="learning-tools-row">
            <div
              className="learning-tabs"
              role="tablist"
              aria-label="Chapter tools"
            >
              {["learn", "practice", "visuals"].map((t, index) => (
                <button
                  id={`tab-${t}`}
                  role="tab"
                  aria-selected={tab === t}
                  aria-controls="learning-content"
                  tabIndex={tab === t ? 0 : -1}
                  key={t}
                  onClick={() => activateTab(t)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <button
              id="tab-tutor"
              className="btn btn-outline learning-tutor-launcher"
              aria-haspopup="dialog"
              aria-controls="classroom-tutor-drawer"
              onClick={() => openTutor()}
            >
              Tutor
            </button>
          </div>
          <div
            id="learning-content"
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
          >
            <div hidden={tab !== "learn"} className="learning-panel">
              <h2>Start with the source</h2>
              <p>{chapter.context?.chapterName || chapter.title}</p>
              <ChapterPdfReader chapter={chapter} studentId={user?.userId} targetPage={sourcePage} onAsk={openTutor} onPageChange={setReaderPage} />
              {chapter.concepts?.length > 0 && (
                <>
                  <h3>Key concepts</h3>
                  <ul>
                    {chapter.concepts.map((c) => (
                      <li key={c.conceptId}>{c.label || c.conceptId}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {visited.practice && (
              <div hidden={tab !== "practice"}>
                <Practice key={chapter.id} chapter={chapter} />
              </div>
            )}
            {visited.visuals && (
              <div hidden={tab !== "visuals"}>
                <Visuals key={chapter.id} chapter={chapter} />
              </div>
            )}
          </div>
          {visited.tutor && <>
            <button className="classroom-tutor-scrim" aria-label="Close Tutor" hidden={!tutorOpen} onClick={() => { setTutorOpen(false); document.querySelector("#tab-tutor")?.focus(); }} />
            <aside id="classroom-tutor-drawer" ref={tutorDrawerRef} className={`classroom-tutor-drawer${tutorOpen ? " open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="classroom-tutor-heading" aria-hidden={!tutorOpen}>
              <h2 id="classroom-tutor-heading" className="sr-only">Roognis Tutor</h2>
              <button ref={tutorCloseRef} className="btn btn-outline classroom-tutor-close" onClick={() => { setTutorOpen(false); document.querySelector("#tab-tutor")?.focus(); }}>Close</button>
              <Tutor key={chapter.id} chapter={chapter} initialQuestion={suggestedQuestion} readerPage={readerPage} useCurrentPage={tutorUseCurrentPage} onUseCurrentPageChange={setTutorUseCurrentPage} onSourcePage={page => { setSourcePage(Number(page)); setTutorOpen(false); setTab("learn"); }} />
            </aside>
          </>}
        </>
      )}
    </ResourceState>
  );
}
