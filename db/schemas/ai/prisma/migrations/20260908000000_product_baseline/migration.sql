-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ai_db";

-- CreateEnum
CREATE TYPE "ai_db"."MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ai_db"."VisualArtifactStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ai_db"."ImageJobStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ai_db"."OnboardingStatus" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "ai_db"."chat_sessions" (
    "document_id" UUID,
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "subject" VARCHAR(80) NOT NULL,
    "board" VARCHAR(40),
    "curriculum" VARCHAR(80),
    "grade" INTEGER,
    "chapter_number" INTEGER,
    "chapter_name" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "ai_db"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."image_jobs" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "ai_db"."ImageJobStatus" NOT NULL DEFAULT 'queued',
    "image_url" VARCHAR(500),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."feedback" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_onboarding" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "status" "ai_db"."OnboardingStatus" NOT NULL DEFAULT 'in_progress',
    "question_source" VARCHAR(40) NOT NULL DEFAULT 'fallback',
    "questions" JSONB NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_learning_profiles" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "prompt_context" TEXT NOT NULL,
    "source" VARCHAR(40) NOT NULL DEFAULT 'onboarding',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_learning_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_news_articles" (
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
    "topics" JSONB,
    "entities" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_news_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_interest_nodes" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "key" VARCHAR(90) NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "last_seen" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_interest_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_interest_edges" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_kind" VARCHAR(16) NOT NULL,
    "from_key" VARCHAR(90) NOT NULL,
    "to_kind" VARCHAR(16) NOT NULL,
    "to_key" VARCHAR(90) NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_interest_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_news_signals" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "dwell_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_news_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."student_interest_profiles" (
    "student_id" UUID NOT NULL,
    "summary" JSONB NOT NULL,
    "prompt_context" TEXT NOT NULL,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_interest_profiles_pkey" PRIMARY KEY ("student_id")
);

-- CreateTable
CREATE TABLE "ai_db"."safety_review_flags" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "surface" VARCHAR(24) NOT NULL,
    "session_id" UUID,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_review_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."visual_artifacts" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "status" "ai_db"."VisualArtifactStatus" NOT NULL DEFAULT 'queued',
    "chapter_key" VARCHAR(80) NOT NULL,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "concept_slug" VARCHAR(120) NOT NULL,
    "prompt" TEXT NOT NULL,
    "spec" JSONB,
    "provenance" JSONB,
    "failure_reason" TEXT,
    "model" VARCHAR(80),
    "provider" VARCHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visual_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_db"."preference_delivery" (
    "message_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "last_error" VARCHAR(240),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_delivery_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "ai_db"."generation_tasks" (
    "id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_until" TIMESTAMP(3),
    "lease_token" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_student_id_created_at_idx" ON "ai_db"."chat_sessions"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_sessions_school_id_subject_idx" ON "ai_db"."chat_sessions"("school_id", "subject");

-- CreateIndex
CREATE INDEX "chat_sessions_school_id_subject_grade_chapter_number_idx" ON "ai_db"."chat_sessions"("school_id", "subject", "grade", "chapter_number");

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_idx" ON "ai_db"."messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "image_jobs_student_id_created_at_idx" ON "ai_db"."image_jobs"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "image_jobs_status_created_at_idx" ON "ai_db"."image_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "feedback_message_id_idx" ON "ai_db"."feedback"("message_id");

-- CreateIndex
CREATE INDEX "feedback_student_id_created_at_idx" ON "ai_db"."feedback"("student_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_onboarding_student_id_key" ON "ai_db"."student_onboarding"("student_id");

-- CreateIndex
CREATE INDEX "student_onboarding_school_id_status_idx" ON "ai_db"."student_onboarding"("school_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "student_learning_profiles_student_id_key" ON "ai_db"."student_learning_profiles"("student_id");

-- CreateIndex
CREATE INDEX "student_learning_profiles_school_id_idx" ON "ai_db"."student_learning_profiles"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_news_articles_url_key" ON "ai_db"."student_news_articles"("url");

-- CreateIndex
CREATE INDEX "student_news_articles_safety_status_published_at_idx" ON "ai_db"."student_news_articles"("safety_status", "published_at");

-- CreateIndex
CREATE INDEX "student_news_articles_category_published_at_idx" ON "ai_db"."student_news_articles"("category", "published_at");

-- CreateIndex
CREATE INDEX "student_interest_nodes_student_id_weight_idx" ON "ai_db"."student_interest_nodes"("student_id", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "student_interest_nodes_student_id_kind_key_key" ON "ai_db"."student_interest_nodes"("student_id", "kind", "key");

-- CreateIndex
CREATE INDEX "student_interest_edges_student_id_weight_idx" ON "ai_db"."student_interest_edges"("student_id", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "student_interest_edges_student_id_from_kind_from_key_to_kin_key" ON "ai_db"."student_interest_edges"("student_id", "from_kind", "from_key", "to_kind", "to_key");

-- CreateIndex
CREATE INDEX "student_news_signals_student_id_created_at_idx" ON "ai_db"."student_news_signals"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "student_news_signals_student_id_article_id_idx" ON "ai_db"."student_news_signals"("student_id", "article_id");

-- CreateIndex
CREATE INDEX "safety_review_flags_school_id_acknowledged_at_created_at_idx" ON "ai_db"."safety_review_flags"("school_id", "acknowledged_at", "created_at");

-- CreateIndex
CREATE INDEX "safety_review_flags_student_id_created_at_idx" ON "ai_db"."safety_review_flags"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "visual_artifacts_student_id_created_at_idx" ON "ai_db"."visual_artifacts"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "visual_artifacts_cache_idx" ON "ai_db"."visual_artifacts"("student_id", "kind", "chapter_key", "content_fingerprint", "concept_slug");

-- CreateIndex
CREATE INDEX "visual_artifacts_status_created_at_idx" ON "ai_db"."visual_artifacts"("status", "created_at");

-- CreateIndex
CREATE INDEX "preference_delivery_delivered_at_next_attempt_at_idx" ON "ai_db"."preference_delivery"("delivered_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "generation_tasks_status_available_at_idx" ON "ai_db"."generation_tasks"("status", "available_at");

-- AddForeignKey
ALTER TABLE "ai_db"."messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_db"."chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_db"."feedback" ADD CONSTRAINT "feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_db"."messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

