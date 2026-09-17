import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon, StatusBadge } from "../../components/ui.jsx";
import { learningApi } from "./client";
import { PageHeading, ResourceState, useResource } from "./shared";

export default function Learn() {
  const resource = useResource(learningApi.catalog);
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState("");
  const items = resource.data?.items || [];
  const subjects = [...new Set(items.map((item) => item.context?.subject).filter(Boolean))];
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesQuery = !normalized || `${item.title} ${item.context?.chapterName || ""} ${item.context?.subject || ""}`.toLowerCase().includes(normalized);
      const matchesSubject = !subject || item.context?.subject === subject;
      return matchesQuery && matchesSubject;
    });
  }, [items, query, subject]);

  return (
    <>
      <PageHeading
        eyebrow="LEARNING LIBRARY"
        title="Understand. Explore. Remember."
        description="Your published class chapters, with a tutor and practice alongside every lesson."
      />
      <div className="learning-library-tools" role="search">
        <label className="field learning-search-field">
          <span>Search chapters</span>
          <span className="input-with-icon"><Icon name="inbox" size={17} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by chapter or subject" /></span>
        </label>
        <label className="field learning-subject-field">
          <span>Subject</span>
          <select className="select" value={subject} onChange={(event) => setSubject(event.target.value)}>
            <option value="">All subjects</option>
            {subjects.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="learning-results-count" aria-live="polite">{filteredItems.length} chapter{filteredItems.length === 1 ? "" : "s"}</div>
      </div>
      <ResourceState
        resource={resource}
        empty={!resource.loading && !resource.error && !items.length ? "Join a class and your teacher’s published chapters will appear here." : null}
      >
        {filteredItems.length ? (
          <div className="learning-cards">
            {filteredItems.map((item, index) => (
              <Link to={`/learn/${item.id}`} className="learning-course" key={item.id}>
                <div className={`learning-cover tone-${index % 4}`}>
                  <span>{item.context?.subject || "Explore"}</span>
                  <Icon name={index % 3 === 0 ? "book" : index % 3 === 1 ? "spark" : "insights"} size={42} />
                </div>
                <div className="learning-course-body">
                  <span className="learning-eyebrow">CHAPTER {item.context?.chapterNumber || "·"}</span>
                  <h2>{item.title}</h2>
                  <p className="muted">Read, ask your tutor, and build confidence with practice.</p>
                  <div className="learning-card-footer">
                    <StatusBadge tone="success" label="Published" icon="check" />
                    <span className="text-link">Start learning <Icon name="arrow" size={15} /></span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="learning-empty"><h3>No chapters match that search.</h3><p>Try another subject or clear the search to see your published learning space.</p><button className="btn btn-outline" onClick={() => { setQuery(""); setSubject(""); }}>Clear filters</button></div>
        )}
      </ResourceState>
    </>
  );
}
