-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "discover_db";

-- CreateEnum
CREATE TYPE "discover_db"."AcademicCardStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "discover_db"."AcademicCardKind" AS ENUM ('mcq_card', 'micro_article');

-- CreateTable
CREATE TABLE "discover_db"."interest_topics" (
    "key" VARCHAR(90) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "cluster" VARCHAR(40) NOT NULL,
    "terms" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interest_topics_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "discover_db"."interest_nodes" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "key" VARCHAR(90) NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "origin" VARCHAR(20) NOT NULL DEFAULT 'behaviour',
    "last_seen" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interest_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."interest_edges" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_kind" VARCHAR(16) NOT NULL,
    "from_key" VARCHAR(90) NOT NULL,
    "to_kind" VARCHAR(16) NOT NULL,
    "to_key" VARCHAR(90) NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sign" INTEGER NOT NULL DEFAULT 1,
    "relationship" VARCHAR(24) NOT NULL DEFAULT 'TOPIC_CO_OCCURS',
    "source" VARCHAR(24) NOT NULL DEFAULT 'co_occurrence',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.45,
    "evidence_ref" VARCHAR(240),
    "model_version" VARCHAR(80),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interest_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."interest_candidates" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "key" VARCHAR(90) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "cluster" VARCHAR(40) NOT NULL DEFAULT 'other',
    "evidence_count" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "interest_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."discover_articles" (
    "id" UUID NOT NULL,
    "source_key" VARCHAR(80) NOT NULL,
    "source_name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "summary" TEXT NOT NULL,
    "url" VARCHAR(1200) NOT NULL,
    "image_url" VARCHAR(1600),
    "published_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "safety_status" VARCHAR(30) NOT NULL DEFAULT 'approved',
    "origin" VARCHAR(20) NOT NULL DEFAULT 'rss',
    "hunt_topic_key" VARCHAR(90),
    "topics" JSONB,
    "entities" JSONB,
    "raw_title" VARCHAR(240),
    "raw_summary" TEXT,
    "tone_rewritten" BOOLEAN NOT NULL DEFAULT false,
    "tone_model" VARCHAR(80),
    "tone_provider" VARCHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discover_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."news_signals" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "session_id" VARCHAR(64),
    "kind" VARCHAR(20) NOT NULL,
    "dwell_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."student_interest_profiles" (
    "student_id" UUID NOT NULL,
    "summary" JSONB NOT NULL,
    "prompt_context" TEXT NOT NULL,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "imported_legacy_graph_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_interest_profiles_pkey" PRIMARY KEY ("student_id")
);

-- CreateTable
CREATE TABLE "discover_db"."student_preferences" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "topic_key" VARCHAR(90) NOT NULL,
    "stance" VARCHAR(16) NOT NULL,
    "source" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence_ref" VARCHAR(240),
    "model_version" VARCHAR(80),
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "last_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."preference_observations" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(96) NOT NULL,
    "student_id" UUID NOT NULL,
    "topic_key" VARCHAR(90) NOT NULL,
    "stance" VARCHAR(16) NOT NULL,
    "source" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence_ref" VARCHAR(240),
    "model_version" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."preference_refresh_runs" (
    "id" UUID NOT NULL,
    "run_key" VARCHAR(80) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "profile_count" INTEGER NOT NULL DEFAULT 0,
    "model_version" VARCHAR(80),
    "training_status" VARCHAR(24) NOT NULL DEFAULT 'not_started',
    "training_promoted" BOOLEAN NOT NULL DEFAULT false,
    "training_reason" VARCHAR(80),
    "lease_expires_at" TIMESTAMP(3),
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "preference_refresh_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."preference_decision_records" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "topic_key" VARCHAR(90) NOT NULL,
    "affinity" DOUBLE PRECISION NOT NULL,
    "source" VARCHAR(24) NOT NULL,
    "override_applied" BOOLEAN NOT NULL DEFAULT false,
    "rule_version" VARCHAR(80) NOT NULL,
    "model_version" VARCHAR(80),
    "evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_decision_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."hunt_runs" (
    "id" UUID NOT NULL,
    "topic_key" VARCHAR(90) NOT NULL,
    "topic_label" VARCHAR(120) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "queries" JSONB,
    "provider" VARCHAR(24),
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "stored_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hunt_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."academic_cards" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "status" "discover_db"."AcademicCardStatus" NOT NULL DEFAULT 'queued',
    "kind" "discover_db"."AcademicCardKind" NOT NULL DEFAULT 'mcq_card',
    "chapter_key" VARCHAR(80) NOT NULL,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "spec" JSONB,
    "provenance" JSONB,
    "target_weak_area" VARCHAR(160) NOT NULL,
    "document_ids" TEXT[],
    "source_service" VARCHAR(16) NOT NULL,
    "failure_reason" TEXT,
    "model" VARCHAR(80),
    "provider" VARCHAR(24),
    "viewed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."academic_card_attempts" (
    "id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "selected_answer" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_card_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."video_hunt_runs" (
    "id" UUID NOT NULL,
    "topic_key" VARCHAR(90) NOT NULL,
    "topic_label" VARCHAR(120) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "queries" JSONB,
    "provider" VARCHAR(24),
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "stored_count" INTEGER NOT NULL DEFAULT 0,
    "channels_enriched" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_hunt_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."discover_videos" (
    "id" UUID NOT NULL,
    "video_id" VARCHAR(32) NOT NULL,
    "channel_id" VARCHAR(32) NOT NULL,
    "channel_name" VARCHAR(160) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "summary" TEXT NOT NULL,
    "url" VARCHAR(300) NOT NULL,
    "thumbnail_url" VARCHAR(1600),
    "published_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "safety_status" VARCHAR(30) NOT NULL DEFAULT 'approved',
    "origin" VARCHAR(20) NOT NULL DEFAULT 'hunt',
    "hunt_topic_key" VARCHAR(90),
    "topics" JSONB,
    "entities" JSONB,
    "channel_trust_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "channel_narrowness" DOUBLE PRECISION,
    "niche_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discover_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."trusted_channels" (
    "id" UUID NOT NULL,
    "channel_id" VARCHAR(32) NOT NULL,
    "channel_name" VARCHAR(160) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "subscriber_count" INTEGER,
    "video_count" INTEGER,
    "topic_narrowness" DOUBLE PRECISION,
    "dominant_topic_key" VARCHAR(90),
    "last_enriched_at" TIMESTAMP(3),
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "seed_source" VARCHAR(20),
    "promoted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trusted_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."video_signals" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "session_id" VARCHAR(64),
    "kind" VARCHAR(20) NOT NULL,
    "dwell_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discover_db"."preference_controls" (
    "student_id" UUID NOT NULL,
    "scope_hash" VARCHAR(64) NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preference_controls_pkey" PRIMARY KEY ("student_id","scope_hash")
);

-- CreateTable
CREATE TABLE "discover_db"."preference_receipts" (
    "digest" VARCHAR(64) NOT NULL,
    "student_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_receipts_pkey" PRIMARY KEY ("digest")
);

-- CreateIndex
CREATE INDEX "interest_topics_status_idx" ON "discover_db"."interest_topics"("status");

-- CreateIndex
CREATE INDEX "interest_nodes_student_id_weight_idx" ON "discover_db"."interest_nodes"("student_id", "weight");

-- CreateIndex
CREATE INDEX "interest_nodes_kind_key_idx" ON "discover_db"."interest_nodes"("kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "interest_nodes_student_id_kind_key_key" ON "discover_db"."interest_nodes"("student_id", "kind", "key");

-- CreateIndex
CREATE INDEX "interest_edges_student_id_weight_idx" ON "discover_db"."interest_edges"("student_id", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "interest_edges_student_pair_sign_key" ON "discover_db"."interest_edges"("student_id", "from_kind", "from_key", "to_kind", "to_key", "sign");

-- CreateIndex
CREATE INDEX "interest_candidates_student_id_status_proposed_at_idx" ON "discover_db"."interest_candidates"("student_id", "status", "proposed_at");

-- CreateIndex
CREATE UNIQUE INDEX "interest_candidates_student_id_key_key" ON "discover_db"."interest_candidates"("student_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "discover_articles_url_key" ON "discover_db"."discover_articles"("url");

-- CreateIndex
CREATE INDEX "discover_articles_safety_status_published_at_idx" ON "discover_db"."discover_articles"("safety_status", "published_at");

-- CreateIndex
CREATE INDEX "discover_articles_category_published_at_idx" ON "discover_db"."discover_articles"("category", "published_at");

-- CreateIndex
CREATE INDEX "discover_articles_hunt_topic_key_published_at_idx" ON "discover_db"."discover_articles"("hunt_topic_key", "published_at");

-- CreateIndex
CREATE INDEX "news_signals_student_id_created_at_idx" ON "discover_db"."news_signals"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "news_signals_student_id_article_id_idx" ON "discover_db"."news_signals"("student_id", "article_id");

-- CreateIndex
CREATE INDEX "student_preferences_student_id_muted_updated_at_idx" ON "discover_db"."student_preferences"("student_id", "muted", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_preferences_student_id_topic_key_key" ON "discover_db"."student_preferences"("student_id", "topic_key");

-- CreateIndex
CREATE INDEX "preference_observations_student_id_created_at_idx" ON "discover_db"."preference_observations"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "preference_observations_student_id_topic_key_created_at_idx" ON "discover_db"."preference_observations"("student_id", "topic_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "preference_observations_student_id_event_id_topic_key_key" ON "discover_db"."preference_observations"("student_id", "event_id", "topic_key");

-- CreateIndex
CREATE UNIQUE INDEX "preference_refresh_runs_run_key_key" ON "discover_db"."preference_refresh_runs"("run_key");

-- CreateIndex
CREATE INDEX "preference_refresh_runs_status_started_at_idx" ON "discover_db"."preference_refresh_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "preference_decision_records_student_id_topic_key_created_at_idx" ON "discover_db"."preference_decision_records"("student_id", "topic_key", "created_at");

-- CreateIndex
CREATE INDEX "hunt_runs_status_created_at_idx" ON "discover_db"."hunt_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "hunt_runs_topic_key_created_at_idx" ON "discover_db"."hunt_runs"("topic_key", "created_at");

-- CreateIndex
CREATE INDEX "academic_cards_student_id_created_at_idx" ON "discover_db"."academic_cards"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "academic_cards_cache_idx" ON "discover_db"."academic_cards"("student_id", "chapter_key", "content_fingerprint", "kind");

-- CreateIndex
CREATE INDEX "academic_card_attempts_student_id_created_at_idx" ON "discover_db"."academic_card_attempts"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "academic_card_attempts_card_id_student_id_idx" ON "discover_db"."academic_card_attempts"("card_id", "student_id");

-- CreateIndex
CREATE INDEX "video_hunt_runs_status_created_at_idx" ON "discover_db"."video_hunt_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "video_hunt_runs_topic_key_created_at_idx" ON "discover_db"."video_hunt_runs"("topic_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "discover_videos_video_id_key" ON "discover_db"."discover_videos"("video_id");

-- CreateIndex
CREATE UNIQUE INDEX "discover_videos_url_key" ON "discover_db"."discover_videos"("url");

-- CreateIndex
CREATE INDEX "discover_videos_safety_status_published_at_idx" ON "discover_db"."discover_videos"("safety_status", "published_at");

-- CreateIndex
CREATE INDEX "discover_videos_hunt_topic_key_published_at_idx" ON "discover_db"."discover_videos"("hunt_topic_key", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_channels_channel_id_key" ON "discover_db"."trusted_channels"("channel_id");

-- CreateIndex
CREATE INDEX "trusted_channels_status_idx" ON "discover_db"."trusted_channels"("status");

-- CreateIndex
CREATE INDEX "video_signals_student_id_created_at_idx" ON "discover_db"."video_signals"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "video_signals_student_id_video_id_idx" ON "discover_db"."video_signals"("student_id", "video_id");

-- CreateIndex
CREATE INDEX "preference_receipts_student_id_idx" ON "discover_db"."preference_receipts"("student_id");

-- AddForeignKey
ALTER TABLE "discover_db"."news_signals" ADD CONSTRAINT "news_signals_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "discover_db"."discover_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discover_db"."academic_card_attempts" ADD CONSTRAINT "academic_card_attempts_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "discover_db"."academic_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discover_db"."video_signals" ADD CONSTRAINT "video_signals_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "discover_db"."discover_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

