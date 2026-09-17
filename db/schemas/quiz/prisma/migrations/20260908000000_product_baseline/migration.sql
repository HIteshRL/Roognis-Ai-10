-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "quiz_db";

-- CreateTable
CREATE TABLE "quiz_db"."chapter_quiz_sources" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "board" VARCHAR(40) NOT NULL,
    "curriculum" VARCHAR(80) NOT NULL,
    "grade" INTEGER NOT NULL,
    "subject" VARCHAR(80) NOT NULL,
    "book" VARCHAR(180) NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "chapter_name" VARCHAR(220) NOT NULL,
    "language" VARCHAR(80) NOT NULL,
    "edition" VARCHAR(40) NOT NULL,
    "document_ids" JSONB NOT NULL DEFAULT '[]',
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "entity_count" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "quiz_status" VARCHAR(40) NOT NULL DEFAULT 'missing',
    "active_quiz_id" UUID,
    "last_generation_error" TEXT,
    "last_generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapter_quiz_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_db"."quizzes" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID,
    "title" VARCHAR(240) NOT NULL,
    "chapter_summary" TEXT NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'pending_review',
    "approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "question_count" INTEGER NOT NULL,
    "simple_count" INTEGER NOT NULL,
    "medium_count" INTEGER NOT NULL,
    "hard_count" INTEGER NOT NULL,
    "generation_model" VARCHAR(120),
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "source_coverage" JSONB NOT NULL DEFAULT '[]',
    "curriculum_links" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_db"."quiz_attempts" (
    "id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER NOT NULL DEFAULT 0,
    "max_score" INTEGER NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_db"."quiz_questions" (
    "id" UUID NOT NULL,
    "quiz_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "difficulty" VARCHAR(20) NOT NULL,
    "bloom_level" VARCHAR(40) NOT NULL,
    "concept_tag" VARCHAR(160) NOT NULL,
    "concept_id" VARCHAR(160) NOT NULL,
    "misconception_ids" JSONB NOT NULL DEFAULT '[]',
    "weak_area_label" VARCHAR(160) NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "correct_answer" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "source_chunk_ids" JSONB NOT NULL DEFAULT '[]',
    "marks" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_db"."quiz_generation_jobs" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "quiz_id" UUID,
    "trigger" VARCHAR(40) NOT NULL DEFAULT 'manual',
    "status" VARCHAR(40) NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "quiz_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_db"."evidence_outbox" (
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
CREATE TABLE "quiz_db"."generation_tasks" (
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
CREATE INDEX "chapter_quiz_sources_school_id_subject_grade_idx" ON "quiz_db"."chapter_quiz_sources"("school_id", "subject", "grade");

-- CreateIndex
CREATE INDEX "chapter_quiz_sources_school_id_quiz_status_idx" ON "quiz_db"."chapter_quiz_sources"("school_id", "quiz_status");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_quiz_sources_school_id_board_curriculum_grade_subje_key" ON "quiz_db"."chapter_quiz_sources"("school_id", "board", "curriculum", "grade", "subject", "book", "chapter_number", "language", "edition");

-- CreateIndex
CREATE INDEX "quizzes_school_id_status_created_at_idx" ON "quiz_db"."quizzes"("school_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "quizzes_source_id_created_at_idx" ON "quiz_db"."quizzes"("source_id", "created_at");

-- CreateIndex
CREATE INDEX "quiz_attempts_student_id_submitted_at_idx" ON "quiz_db"."quiz_attempts"("student_id", "submitted_at");

-- CreateIndex
CREATE INDEX "quiz_attempts_quiz_id_student_id_idx" ON "quiz_db"."quiz_attempts"("quiz_id", "student_id");

-- CreateIndex
CREATE INDEX "quiz_attempts_school_id_submitted_at_idx" ON "quiz_db"."quiz_attempts"("school_id", "submitted_at");

-- CreateIndex
CREATE INDEX "quiz_questions_quiz_id_order_index_idx" ON "quiz_db"."quiz_questions"("quiz_id", "order_index");

-- CreateIndex
CREATE INDEX "quiz_questions_quiz_id_difficulty_idx" ON "quiz_db"."quiz_questions"("quiz_id", "difficulty");

-- CreateIndex
CREATE INDEX "quiz_questions_concept_id_idx" ON "quiz_db"."quiz_questions"("concept_id");

-- CreateIndex
CREATE INDEX "quiz_generation_jobs_source_id_created_at_idx" ON "quiz_db"."quiz_generation_jobs"("source_id", "created_at");

-- CreateIndex
CREATE INDEX "quiz_generation_jobs_status_idx" ON "quiz_db"."quiz_generation_jobs"("status");

-- CreateIndex
CREATE INDEX "evidence_outbox_delivered_at_next_attempt_at_idx" ON "quiz_db"."evidence_outbox"("delivered_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "generation_tasks_status_available_at_idx" ON "quiz_db"."generation_tasks"("status", "available_at");

-- AddForeignKey
ALTER TABLE "quiz_db"."quizzes" ADD CONSTRAINT "quizzes_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "quiz_db"."chapter_quiz_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_db"."quiz_attempts" ADD CONSTRAINT "quiz_attempts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "quiz_db"."chapter_quiz_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_db"."quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quiz_db"."quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_db"."quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quiz_db"."quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_db"."quiz_generation_jobs" ADD CONSTRAINT "quiz_generation_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "quiz_db"."chapter_quiz_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_db"."quiz_generation_jobs" ADD CONSTRAINT "quiz_generation_jobs_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quiz_db"."quizzes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

