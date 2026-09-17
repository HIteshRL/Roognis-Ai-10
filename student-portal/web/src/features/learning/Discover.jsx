import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "./interest-graph.js";
import "./interest-graph.css";
import { api } from "../../api/client";
import { learningApi, safeExternalUrl } from "./client";
import { PageHeading, ResourceState, useResource, ErrorNotice } from "./shared";
export default function Discover() {
  const resource = useResource(learningApi.feed),
    catalog = useResource(learningApi.catalog),
    [error, setError] = useState(""),
    graph = useRef(null),
    acknowledgedCards = useRef(new Set());
  useEffect(() => () => graph.current?.destroy(), []);
  useEffect(() => {
    for (const item of resource.data?.items || []) {
      const card = item.kind === "micro_article" ? item.card : null;
      if (!card?.cardId || card.viewedAt || acknowledgedCards.current.has(card.cardId)) continue;
      acknowledgedCards.current.add(card.cardId);
      api.post(`/discover/cards/${encodeURIComponent(card.cardId)}/viewed`).catch((requestError) => {
        setError(requestError.message || "We couldn’t record that this story was viewed.");
      });
    }
  }, [resource.data]);
  function openGraph(e) {
    graph.current = window.RoognisInterestGraph.mount({
      trigger: e.currentTarget,
      loadGraph: async () => api.get("/discover/interests"),
    });
  }
  async function signal(item, kind) {
    const entity = item.article || item.video;
    if (!entity) return;
    try {
      await api.post("/discover/signal", {
        eventId: crypto.randomUUID(),
        kind,
        [item.video ? "videoId" : "articleId"]: entity.id,
      });
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="FOLLOW YOUR CURIOSITY"
        title="There’s more to discover."
        description="Stories and ideas beyond the textbook, with preferences you control."
      />
      <div className="row">
        <Link to="/settings">Manage your interests →</Link>
        <button className="btn btn-outline" onClick={openGraph}>
          Explore my interest graph
        </button>
      </div>
      <ErrorNotice message={error} />
      <ResourceState
        resource={resource}
        empty={
          !resource.loading && !resource.error && !resource.data?.items?.length
            ? "Fresh stories will appear when the content collection is ready. Your coursework is available in Classes."
            : null
        }
      >
        <div className="learning-cards">
          {resource.data?.items?.map((item, index) => {
            const entity = item.article || item.video || item.card,
              url = safeExternalUrl(entity.url),
              documentId = entity.documentIds?.[0],
              chapter = catalog.data?.items?.find((candidate) => candidate.documentId === documentId),
              action = item.kind === "micro_article" && ["tutor", "practice"].includes(entity.ctaType)
                ? {
                    label: entity.ctaType === "tutor" ? "Ask Tutor about this" : "Practise this topic",
                    to: chapter ? `/learn/${encodeURIComponent(chapter.id)}?tool=${entity.ctaType}` : "/learn",
                  }
                : null;
            return (
              <article
                className="learning-course"
                key={entity.id || entity.cardId || index}
              >
                <div className={`learning-cover tone-${index % 4}`}>
                  <span>
                    {entity.categoryLabel ||
                      (item.kind === "video" ? "Watch" : "Explore")}
                  </span>
                  <b aria-hidden="true">{["✧", "◎", "◈", "↗"][index % 4]}</b>
                </div>
                <div className="learning-course-body">
                  <p className="learning-eyebrow">
                    {entity.sourceName || entity.channelName || "YOUR LEARNING"}
                  </p>
                  <h2>{entity.title || entity.headline}</h2>
                  <p>{entity.summary || entity.body}</p>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => signal(item, "open")}
                    >
                      Read more ↗
                    </a>
                  )}
                  {action ? (
                    <Link className="btn btn-outline" to={action.to}>
                      {action.label}
                    </Link>
                  ) : null}
                  <div className="row">
                    {(item.article || item.video) && (
                      <button
                        className="btn btn-ghost"
                        onClick={() => signal(item, "skip")}
                      >
                        Less like this
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </ResourceState>
    </>
  );
}
