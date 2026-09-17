import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { Icon, Metric, StatusBadge } from "../../components/ui.jsx";
import { statusToneFor } from "../../app/theme";
import { learningApi } from "./client";
import { PageHeading, ResourceState, useResource } from "./shared";
import StudyVisual from "./StudyVisual";

function getTodoItems(data) {
  return [
    ...(data?.overdue || []),
    ...(data?.dueToday || []),
    ...(data?.upcoming || []),
  ];
}

export default function Today() {
  const { user } = useAuth();
  const catalog = useResource(learningApi.catalog);
  const resume = useResource(() => learningApi.studyVisualResume("light"));
  const todo = useResource(() => api.get("/lms/student/todo"));
  const items = getTodoItems(todo.data);
  const hasTodoSnapshot = todo.data !== null;
  const resumedVersionId = resume.data?.resume?.learningVersionId;
  const nextChapter = catalog.data?.items?.find((item) => item.id === resumedVersionId) || catalog.data?.items?.[0];
  const firstName = user.name?.split(" ")[0] || "learner";

  return (
    <>
      <PageHeading
        eyebrow="YOUR LEARNING DAY"
        title={`Let’s make progress, ${firstName}.`}
        description="Start with one useful next step. Your coursework and reflection come after the learning action."
      />

      <div className="today-layout">
        <section className="today-focus" aria-labelledby="today-focus-title">
          <div className="today-focus-copy">
            <p className="learning-eyebrow">CONTINUE LEARNING</p>
            <h2 id="today-focus-title">
              {nextChapter?.title || "Make space for your next discovery."}
            </h2>
            <p>
              {nextChapter
                ? `Pick up where you left off in ${nextChapter.context?.subject || "this chapter"}. Read, ask your tutor, and practise with purpose.`
                : "Explore a published chapter, ask a question, or practise something you already know."}
            </p>
            <ResourceState resource={catalog}>
              {nextChapter ? (
                <Link className="btn btn-primary today-focus-action" to={`/learn/${nextChapter.id}`} aria-label={`Start learning ${nextChapter.title}`}>
                  Start learning <Icon name="arrow" size={17} />
                </Link>
              ) : (
                <Link className="btn btn-primary today-focus-action" to="/learn">
                  Open learning space <Icon name="arrow" size={17} />
                </Link>
              )}
            </ResourceState>
          </div>
          <div className="today-focus-mark">
            {nextChapter ? <StudyVisual chapter={nextChapter} compact initialVisual={resume.data?.visual} /> : <Icon name="spark" size={48} />}
          </div>
        </section>

        <aside className="today-goal" aria-labelledby="today-goal-title">
          <div className="today-goal-heading">
            <span className="today-goal-icon"><Icon name="calendar" size={19} /></span>
            <div>
              <p className="learning-eyebrow">TODAY&apos;S VIEW</p>
              <h2 id="today-goal-title">What needs your attention</h2>
            </div>
          </div>
          <p className="today-goal-number">{hasTodoSnapshot ? items.length : "—"}</p>
          <p className="muted">
            {hasTodoSnapshot
              ? `coursework item${items.length === 1 ? "" : "s"} across your classes`
              : todo.error ? "Coursework status unavailable" : "Loading coursework status…"}
          </p>
          <Link className="text-link" to="/classes">Open my classes <Icon name="arrow" size={15} /></Link>
        </aside>
      </div>

      <div className="today-support-grid">
        <section className="learning-panel today-coursework" aria-labelledby="coursework-title">
          <div className="section-heading-row">
            <div>
              <p className="learning-eyebrow">KEEP MOVING</p>
              <h2 id="coursework-title">Coursework</h2>
            </div>
            <Link className="text-link" to="/classes">View classes <Icon name="arrow" size={15} /></Link>
          </div>
          <ResourceState resource={todo}>
            {items.slice(0, 5).map((item) => (
              <Link
                className="learning-list-row"
                key={item.courseworkId || item.id}
                to={`/classes/${item.classroomId}/work/${item.courseworkId || item.id}`}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.classroomName || "Your class"}</small>
                </span>
                <StatusBadge
                  tone={statusToneFor(item.status)}
                  label={item.status || "Assigned"}
                />
              </Link>
            ))}
            {!items.length ? (
              <div className="today-empty-copy">No upcoming work to show. Check your classes for announcements.</div>
            ) : null}
          </ResourceState>
        </section>

        <section className="learning-panel today-reflection" aria-labelledby="reflection-title">
          <div className="section-heading-row">
            <div>
              <p className="learning-eyebrow">REFLECT</p>
              <h2 id="reflection-title">Build understanding</h2>
            </div>
            <Icon name="trend" size={21} />
          </div>
          <p>Practice and spaced review turn a completed task into knowledge you can use again.</p>
          <div className="today-reflection-actions">
            <Link className="btn btn-outline" to="/revision">Review cards</Link>
            <Link className="text-link" to="/progress">See progress <Icon name="arrow" size={15} /></Link>
          </div>
          <div className="today-metrics" aria-label="Learning activities">
            <Metric label="Published chapters" value={catalog.data?.items?.length ?? "—"} hint="available to study" />
            <Metric label="Work due" value={hasTodoSnapshot ? items.length : "—"} hint={hasTodoSnapshot ? "from your classes" : "coursework unavailable"} tone={hasTodoSnapshot ? (items.length ? "warning" : "success") : "neutral"} />
          </div>
        </section>
      </div>
    </>
  );
}
