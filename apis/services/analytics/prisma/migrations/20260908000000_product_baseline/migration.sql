-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "analytics_db";

-- CreateTable
CREATE TABLE "analytics_db"."events" (
    "id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "student_id" UUID,
    "school_id" UUID NOT NULL,
    "subject" VARCHAR(80),
    "session_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_db"."attendance" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_db"."scores" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "subject" VARCHAR(80) NOT NULL,
    "test_name" VARCHAR(120) NOT NULL,
    "score" DECIMAL(5,2) NOT NULL,
    "max_score" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "test_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_db"."class_assignments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "class_name" VARCHAR(120),
    "subject" VARCHAR(80) NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_school_id_type_created_at_idx" ON "analytics_db"."events"("school_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "events_student_id_created_at_idx" ON "analytics_db"."events"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "events_session_id_idx" ON "analytics_db"."events"("session_id");

-- CreateIndex
CREATE INDEX "attendance_school_id_date_idx" ON "analytics_db"."attendance"("school_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_student_id_date_key" ON "analytics_db"."attendance"("student_id", "date");

-- CreateIndex
CREATE INDEX "scores_student_id_subject_idx" ON "analytics_db"."scores"("student_id", "subject");

-- CreateIndex
CREATE INDEX "scores_school_id_test_date_idx" ON "analytics_db"."scores"("school_id", "test_date");

-- CreateIndex
CREATE INDEX "class_assignments_school_id_teacher_id_idx" ON "analytics_db"."class_assignments"("school_id", "teacher_id");

-- CreateIndex
CREATE INDEX "class_assignments_student_id_idx" ON "analytics_db"."class_assignments"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_assignments_teacher_id_student_id_subject_key" ON "analytics_db"."class_assignments"("teacher_id", "student_id", "subject");

