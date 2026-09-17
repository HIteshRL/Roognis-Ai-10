-- Chapter-aware, same-student decorative visual cache. The only learner-state
-- pointer is an explicit chapter-open event; no answers, grades, names, chat
-- messages, or behavioural telemetry are copied into this schema.
CREATE TABLE "ai_db"."study_visuals" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "learning_version_id" UUID NOT NULL,
    "subject" VARCHAR(80) NOT NULL,
    "chapter_name" VARCHAR(160) NOT NULL,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "visual_key" VARCHAR(64) NOT NULL,
    "visual_state" VARCHAR(16) NOT NULL,
    "theme" VARCHAR(12) NOT NULL,
    "prompt" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "image_url" VARCHAR(500),
    "failure_reason" TEXT,
    "provider" VARCHAR(32),
    "model" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_visuals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_db"."study_resume_contexts" (
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "learning_version_id" UUID NOT NULL,
    "subject" VARCHAR(80) NOT NULL,
    "chapter_name" VARCHAR(160) NOT NULL,
    "content_fingerprint" VARCHAR(80) NOT NULL,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_resume_contexts_pkey" PRIMARY KEY ("student_id")
);

CREATE UNIQUE INDEX "study_visuals_visual_key_key" ON "ai_db"."study_visuals"("visual_key");
CREATE INDEX "study_visuals_student_id_updated_at_idx" ON "ai_db"."study_visuals"("student_id", "updated_at");
CREATE INDEX "study_visuals_student_document_theme_updated_idx" ON "ai_db"."study_visuals"("student_id", "document_id", "theme", "updated_at");
CREATE INDEX "study_visuals_status_created_at_idx" ON "ai_db"."study_visuals"("status", "created_at");
CREATE INDEX "study_resume_contexts_school_last_active_idx" ON "ai_db"."study_resume_contexts"("school_id", "last_active_at");
