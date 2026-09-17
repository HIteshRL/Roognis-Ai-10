import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Icon, StatusBadge, EmptyState, Loading, useToast } from "../components/ui.jsx";
import { getGuardianSummary, listGuardianStudents, redeemGuardianCode } from "../features/shared/services/lmsService";
import { fmtDate } from "../lib/format";

/**
 * "Link a child" — a logged-in parent redeems a code a teacher shared
 * directly with them (text, printed slip; there is no email-send flow in
 * this codebase). Always shown, not just when `students` is empty: a
 * parent may be linked to one child already and be redeeming a code for a
 * second. On success, reloads the linked-students list so the newly linked
 * child appears without a re-login — `guardians.py::linked_student_ids`
 * checks the Auth Service live on every read, so this works immediately.
 * @param {{ onLinked: () => void }} props
 */
function LinkChildCard({ onLinked }) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const guardian = await redeemGuardianCode(trimmed);
      setCode("");
      toast.success(guardian.studentId ? "Child linked to your account." : "Code redeemed.");
      onLinked();
    } catch (error) {
      toast.error(error.message || "That code could not be redeemed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="guardian-link-card" aria-labelledby="guardian-link-title">
      <div>
        <h2 id="guardian-link-title">Link a child</h2>
        <p>Enter the code your child&apos;s teacher shared with you.</p>
      </div>
      <form onSubmit={submit} className="guardian-link-form">
        <input
          className="input"
          placeholder="e.g. 7F3KQPX9"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          maxLength={16}
          autoCapitalize="characters"
          aria-label="Guardian code"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? "Linking…" : "Link"}
        </button>
      </form>
    </section>
  );
}

function ReportSection({ title, description, icon, items, render, empty, tone = "neutral" }) {
  return (
    <section className={`guardian-report-card guardian-report-${tone}`} aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-title`}>
      <div className="guardian-report-head">
        <span className="guardian-report-icon"><Icon name={icon} size={19} /></span>
        <div><h2 id={`${title.toLowerCase().replaceAll(" ", "-")}-title`}>{title}</h2><p>{description}</p></div>
        <StatusBadge tone={tone === "danger" ? "danger" : tone === "success" ? "success" : "neutral"} label={`${items.length}`} />
      </div>
      {items.length === 0 ? <div className="guardian-report-empty">{empty}</div> : <div className="guardian-report-list">{items.map(render)}</div>}
    </section>
  );
}

function WorkRow({ item, badge, tone }) {
  return (
    <div className="guardian-work-row">
      <div><strong>{item.title}</strong><span>{item.classroomName || "Class"}</span></div>
      <StatusBadge tone={tone} label={badge} />
    </div>
  );
}

export default function Guardian() {
  const toast = useToast();
  const [students, setStudents] = useState(null);
  const [active, setActive] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [studentsError, setStudentsError] = useState("");
  const summaryRequest = useRef(0);

  async function loadStudents() {
    setStudentsError("");
    try {
      const linkedStudents = await listGuardianStudents();
      setStudents(linkedStudents);
      if (linkedStudents.length) setActive((current) => current || linkedStudents[0].studentId);
    } catch (error) {
      const message = error.message || "The reporting service did not respond.";
      setStudentsError(message);
      toast.error(message);
      setStudents([]);
    }
  }

  useEffect(() => { loadStudents(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSummary(studentId) {
    const requestId = ++summaryRequest.current;
    setSummary(null);
    setSummaryError("");
    try {
      const nextSummary = await getGuardianSummary(studentId);
      if (requestId === summaryRequest.current) setSummary(nextSummary);
    } catch (error) {
      if (requestId === summaryRequest.current) {
        setSummaryError(error.message || "The reporting service did not respond.");
      }
    }
  }

  useEffect(() => {
    if (active) loadSummary(active);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = students?.find((student) => student.studentId === active);
  const upcoming = summary?.upcoming || [];
  const missing = summary?.missing || [];
  const recentGrades = summary?.recentGrades || [];
  const supportAction = useMemo(() => {
    if (missing[0]) return { title: "Start with one overdue task", body: `Help ${current?.studentName || "your child"} find a small first step in “${missing[0].title}”.` };
    if (upcoming[0]) return { title: "Make the next deadline visible", body: `Check in about “${upcoming[0].title}”, due ${upcoming[0].dueAt ? fmtDate(upcoming[0].dueAt) : "soon"}.` };
    return { title: "Ask what they can explain", body: "A short conversation about a recent lesson can reinforce understanding without turning home into another classroom." };
  }, [current?.studentName, missing, upcoming]);

  if (students === null) return <Loading label="Loading linked children…" />;
  if (studentsError) return <EmptyState icon="warning" title="Reporting service unavailable" hint={studentsError} action={<button className="btn btn-outline" onClick={loadStudents}>Try again</button>} />;
  if (students.length === 0) {
    return (
      <div className="guardian-page">
        <EmptyState icon="family" title="No linked students" hint="A teacher can share a code with you to link your account to a student’s progress." />
        <LinkChildCard onLinked={loadStudents} />
      </div>
    );
  }

  return (
    <div className="guardian-page">
      <div className="guardian-heading">
        <div><p className="ui-eyebrow">FAMILY VIEW · READ ONLY</p><h1>Understand the next step.</h1><p>Plain-language learning context for the children linked to your account.</p></div>
        {students.length > 1 ? (
          <label className="field guardian-child-selector"><span>Child</span><select className="select" value={active || ""} onChange={(event) => setActive(event.target.value)}>{students.map((student) => <option key={student.studentId} value={student.studentId}>{student.studentName || "Student"}</option>)}</select></label>
        ) : null}
      </div>

      <LinkChildCard onLinked={loadStudents} />

      <section className="guardian-hero" aria-labelledby="guardian-child-title">
        <Avatar name={current?.studentName} id={active} size="lg" />
        <div className="guardian-hero-copy"><p className="learning-eyebrow">CURRENT CHILD</p><h2 id="guardian-child-title">{current?.studentName || "Student"}</h2><p>Here is what is upcoming, what needs attention, and what has been returned by teachers.</p></div>
        <StatusBadge tone="info" label="Read-only report" icon="family" />
      </section>

      {summaryError ? <div className="error-notice guardian-error" role="alert"><strong>We couldn&apos;t load this report.</strong><span>{summaryError}</span><button className="btn btn-outline btn-sm" onClick={() => loadSummary(active)}>Try again</button></div> : null}
      {!summary && !summaryError ? <Loading label="Preparing the report…" /> : null}
      {summary ? (
        <>
          <div className="guardian-report-grid">
            <ReportSection title="Upcoming" description="Work with a future due date" icon="calendar" items={upcoming} empty="Nothing is due soon." tone="info" render={(item) => <WorkRow key={item.courseworkId} item={item} badge={item.dueAt ? `Due ${fmtDate(item.dueAt)}` : "Upcoming"} tone="info" />} />
            <ReportSection title="Needs attention" description="Work currently marked missing" icon="warning" items={missing} empty="No missing work right now." tone="danger" render={(item) => <WorkRow key={item.courseworkId} item={item} badge="Overdue" tone="danger" />} />
            <ReportSection title="Returned grades" description="Only results released to the student" icon="check" items={recentGrades} empty="No grades returned yet." tone="success" render={(item) => <WorkRow key={item.courseworkId} item={item} badge={`${item.score}${item.maxPoints != null ? ` / ${item.maxPoints}` : ""}`} tone="success" />} />
          </div>
          <div className="guardian-support-grid">
            <section className="guardian-support-card"><p className="learning-eyebrow">ONE PRACTICAL SUPPORT ACTION</p><h2>{supportAction.title}</h2><p>{supportAction.body}</p></section>
            <aside className="guardian-capability"><Icon name="inbox" size={20} /><div><strong>Need more context?</strong><p>This report does not include teacher-only queues or private signals. Use your school&apos;s existing contact channel for questions about an assignment or returned grade.</p></div></aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
