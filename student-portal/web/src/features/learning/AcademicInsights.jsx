import { useState } from "react";
import { api } from "../../api/client";
import { PageHeading, ResourceState, useResource } from "./shared";
export default function AcademicInsights() {
  const classes = useResource(() => api.get("/lms/classrooms")),
    [id, setId] = useState("");
  const aggregate = useResource(
    () =>
      id
        ? api.get(`/privacy/classes/${id}/knowledge-gaps`)
        : Promise.resolve(null),
    [id],
  );
  return (
    <>
      <PageHeading
        eyebrow="ACADEMIC INSIGHTS"
        title="Support the class with evidence."
        description="Only privacy-filtered academic aggregates appear here. Private learner interests and conversations are excluded."
      />
      <section className="learning-panel">
        <ResourceState resource={classes}>
          <label>
            Class
            <select value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose a class</option>
              {classes.data?.classrooms?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </ResourceState>
      </section>
      {id && (
        <ResourceState resource={aggregate}>
          <section className="learning-panel">
            {aggregate.data?.suppressed ? (
              <>
                <h2>More evidence is needed.</h2>
                <p>
                  This aggregate is withheld because the class does not meet the
                  disclosure requirements.
                </p>
              </>
            ) : (
              <>
                <h2>Concept overview</h2>
                {aggregate.data?.concepts?.map((c) => (
                  <div className="learning-list-row" key={c.conceptId}>
                    <strong>{c.conceptLabel || c.conceptId}</strong>
                    <span>
                      {c.averageMastery != null
                        ? Math.round(c.averageMastery * 100) +
                          "% estimated mastery"
                        : "Evidence available"}
                    </span>
                  </div>
                ))}
                {!aggregate.data?.concepts?.length && (
                  <p>No concept aggregates are available yet.</p>
                )}
              </>
            )}
          </section>
        </ResourceState>
      )}
    </>
  );
}
