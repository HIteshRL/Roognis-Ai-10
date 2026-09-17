-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "practice_db";

-- CreateEnum
CREATE TYPE "practice_db"."PracticeSetStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "practice_db"."practice_sets" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "status" "practice_db"."PracticeSetStatus" NOT NULL DEFAULT 'queued',
    "chapter_key" VARCHAR(80) NOT NULL,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "summary" JSONB,
    "flashcards" JSONB,
    "quiz" JSONB,
    "provenance" JSONB,
    "document_ids" TEXT[],
    "targeting_fingerprint" VARCHAR(80) NOT NULL DEFAULT '',
    "failure_reason" TEXT,
    "model" VARCHAR(80),
    "provider" VARCHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_db"."practice_attempts" (
    "id" UUID NOT NULL,
    "practice_set_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "flashcards_reviewed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_db"."flashcard_review_states" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "practice_set_id" UUID NOT NULL,
    "card_id" VARCHAR(16) NOT NULL,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "interval_days" INTEGER NOT NULL DEFAULT 0,
    "ease_factor" INTEGER NOT NULL DEFAULT 250,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMP(3) NOT NULL,
    "last_reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flashcard_review_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_db"."evidence_outbox" (
    "id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "last_error" VARCHAR(240),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_db"."generation_tasks" (
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
CREATE INDEX "practice_sets_student_id_created_at_idx" ON "practice_db"."practice_sets"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "practice_sets_cache_idx" ON "practice_db"."practice_sets"("student_id", "chapter_key", "content_fingerprint");

-- CreateIndex
CREATE INDEX "practice_sets_targeted_cache_idx" ON "practice_db"."practice_sets"("student_id", "chapter_key", "content_fingerprint", "targeting_fingerprint");

-- CreateIndex
CREATE INDEX "practice_attempts_student_id_created_at_idx" ON "practice_db"."practice_attempts"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "practice_attempts_practice_set_id_student_id_idx" ON "practice_db"."practice_attempts"("practice_set_id", "student_id");

-- CreateIndex
CREATE INDEX "flashcard_review_states_student_id_due_at_idx" ON "practice_db"."flashcard_review_states"("student_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "flashcard_review_identity" ON "practice_db"."flashcard_review_states"("student_id", "practice_set_id", "card_id");

-- CreateIndex
CREATE INDEX "evidence_outbox_delivered_at_next_attempt_at_idx" ON "practice_db"."evidence_outbox"("delivered_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "generation_tasks_status_available_at_idx" ON "practice_db"."generation_tasks"("status", "available_at");

-- AddForeignKey
ALTER TABLE "practice_db"."practice_attempts" ADD CONSTRAINT "practice_attempts_practice_set_id_fkey" FOREIGN KEY ("practice_set_id") REFERENCES "practice_db"."practice_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_db"."flashcard_review_states" ADD CONSTRAINT "flashcard_review_states_practice_set_id_fkey" FOREIGN KEY ("practice_set_id") REFERENCES "practice_db"."practice_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

