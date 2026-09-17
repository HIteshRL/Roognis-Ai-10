CREATE SCHEMA IF NOT EXISTS "school_ops";

CREATE TYPE "school_ops"."SchoolStatus" AS ENUM ('PROVISIONED','ACTIVE','SUSPENDED','ARCHIVED');
CREATE TYPE "school_ops"."MembershipStatus" AS ENUM ('INVITED','ACTIVE','SUSPENDED','ARCHIVED');
CREATE TYPE "school_ops"."RoleKey" AS ENUM ('SCHOOL_ADMIN','TEACHER','STUDENT','GUARDIAN','READ_ONLY');
CREATE TYPE "school_ops"."RelationshipStatus" AS ENUM ('PROPOSED','ACTIVE','REVOKED','EXPIRED');
CREATE TYPE "school_ops"."ImportStatus" AS ENUM ('DRAFT','VALIDATED','COMMITTED','FAILED');
CREATE TYPE "school_ops"."WorkflowStatus" AS ENUM ('QUEUED','RUNNING','WAITING_APPROVAL','WAITING_EXTERNAL','COMPLETED','FAILED','CANCELLED');
CREATE TYPE "school_ops"."WorkflowStepStatus" AS ENUM ('PENDING','RUNNING','WAITING_APPROVAL','WAITING_EXTERNAL','COMPLETED','FAILED','SKIPPED');
CREATE TYPE "school_ops"."ApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED','CANCELLED');
CREATE TYPE "school_ops"."DeliveryStatus" AS ENUM ('PENDING','PROCESSING','DISPATCHED','FAILED');
CREATE TYPE "school_ops"."IdempotencyStatus" AS ENUM ('PROCESSING','COMPLETED');

CREATE TABLE "school_ops"."schools" (
  "id" UUID NOT NULL, "slug" VARCHAR(80) NOT NULL, "display_name" VARCHAR(255) NOT NULL,
  "legal_name" VARCHAR(255), "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  "status" "school_ops"."SchoolStatus" NOT NULL DEFAULT 'PROVISIONED', "policy" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."school_memberships" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "principal_id" UUID NOT NULL,
  "status" "school_ops"."MembershipStatus" NOT NULL DEFAULT 'INVITED', "authz_version" INTEGER NOT NULL DEFAULT 1,
  "source" VARCHAR(80) NOT NULL DEFAULT 'school_ops', "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "school_memberships_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."role_grants" (
  "id" UUID NOT NULL, "membership_id" UUID NOT NULL, "role" "school_ops"."RoleKey" NOT NULL,
  "scope_type" VARCHAR(64) NOT NULL DEFAULT 'school', "scope_id" VARCHAR(128), "granted_by" UUID,
  "revoked_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "role_grants_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."student_profiles" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "membership_id" UUID NOT NULL,
  "admission_number" VARCHAR(120) NOT NULL, "display_name" VARCHAR(255) NOT NULL, "grade" VARCHAR(64), "section" VARCHAR(64),
  "source_system" VARCHAR(80), "source_id" VARCHAR(160), "lifecycle_status" VARCHAR(40) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."guardian_relationships" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "guardian_membership_id" UUID NOT NULL, "student_profile_id" UUID NOT NULL,
  "relationship_type" VARCHAR(80) NOT NULL DEFAULT 'guardian', "status" "school_ops"."RelationshipStatus" NOT NULL DEFAULT 'PROPOSED',
  "disclosure_policy" JSONB NOT NULL DEFAULT '{}', "accepted_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "guardian_relationships_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."roster_import_jobs" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "source" VARCHAR(80) NOT NULL DEFAULT 'csv', "file_digest" VARCHAR(128),
  "payload" JSONB NOT NULL, "validation" JSONB NOT NULL DEFAULT '{}', "status" "school_ops"."ImportStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by" UUID NOT NULL, "committed_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "roster_import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."workflow_runs" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "template_key" VARCHAR(120) NOT NULL, "template_version" INTEGER NOT NULL DEFAULT 1,
  "status" "school_ops"."WorkflowStatus" NOT NULL DEFAULT 'QUEUED', "input" JSONB NOT NULL DEFAULT '{}',
  "correlation_id" UUID NOT NULL, "causation_id" UUID, "idempotency_key" VARCHAR(255) NOT NULL, "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."workflow_step_runs" (
  "id" UUID NOT NULL, "workflow_run_id" UUID NOT NULL, "position" INTEGER NOT NULL, "step_key" VARCHAR(120) NOT NULL,
  "status" "school_ops"."WorkflowStepStatus" NOT NULL DEFAULT 'PENDING', "input" JSONB NOT NULL DEFAULT '{}', "output" JSONB NOT NULL DEFAULT '{}',
  "attempts" INTEGER NOT NULL DEFAULT 0, "lease_until" TIMESTAMP(3), "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."approval_tasks" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "workflow_run_id" UUID NOT NULL, "workflow_step_run_id" UUID,
  "action" VARCHAR(120) NOT NULL, "risk_class" VARCHAR(40) NOT NULL, "status" "school_ops"."ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by" UUID, "decided_by" UUID, "decision_reason" TEXT, "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "approval_tasks_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."outbox_events" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "event_type" VARCHAR(160) NOT NULL, "schema_version" INTEGER NOT NULL DEFAULT 1,
  "subject_type" VARCHAR(80) NOT NULL, "subject_id" VARCHAR(128) NOT NULL, "correlation_id" UUID NOT NULL, "causation_id" UUID,
  "payload" JSONB NOT NULL, "status" "school_ops"."DeliveryStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_until" TIMESTAMP(3), "last_error" TEXT, "dispatched_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."command_receipts" (
  "id" UUID NOT NULL, "service" VARCHAR(80) NOT NULL, "command_id" UUID NOT NULL, "status" VARCHAR(40) NOT NULL,
  "response" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."idempotency_records" (
  "id" UUID NOT NULL, "scope" VARCHAR(255) NOT NULL, "key" VARCHAR(255) NOT NULL, "request_hash" VARCHAR(128) NOT NULL,
  "status" "school_ops"."IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING', "response_code" INTEGER, "response_body" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "school_ops"."audit_events" (
  "id" UUID NOT NULL, "school_id" UUID NOT NULL, "actor_id" UUID, "action" VARCHAR(160) NOT NULL,
  "target_type" VARCHAR(80) NOT NULL, "target_id" VARCHAR(128) NOT NULL, "outcome" VARCHAR(40) NOT NULL,
  "correlation_id" UUID NOT NULL, "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "schools_slug_key" ON "school_ops"."schools"("slug");
CREATE UNIQUE INDEX "school_memberships_school_principal_key" ON "school_ops"."school_memberships"("school_id","principal_id");
CREATE INDEX "school_memberships_principal_status_idx" ON "school_ops"."school_memberships"("principal_id","status");
CREATE INDEX "school_memberships_school_status_idx" ON "school_ops"."school_memberships"("school_id","status");
CREATE UNIQUE INDEX "role_grants_membership_role_scope_key" ON "school_ops"."role_grants"("membership_id","role","scope_type","scope_id");
CREATE INDEX "role_grants_membership_role_idx" ON "school_ops"."role_grants"("membership_id","role","revoked_at");
CREATE UNIQUE INDEX "student_profiles_membership_key" ON "school_ops"."student_profiles"("membership_id");
CREATE UNIQUE INDEX "student_profiles_school_admission_key" ON "school_ops"."student_profiles"("school_id","admission_number");
CREATE UNIQUE INDEX "student_profiles_school_source_key" ON "school_ops"."student_profiles"("school_id","source_system","source_id");
CREATE INDEX "student_profiles_school_status_idx" ON "school_ops"."student_profiles"("school_id","lifecycle_status");
CREATE UNIQUE INDEX "guardian_relationships_guardian_student_key" ON "school_ops"."guardian_relationships"("guardian_membership_id","student_profile_id");
CREATE INDEX "guardian_relationships_school_status_idx" ON "school_ops"."guardian_relationships"("school_id","status");
CREATE INDEX "roster_import_jobs_school_status_idx" ON "school_ops"."roster_import_jobs"("school_id","status");
CREATE UNIQUE INDEX "workflow_runs_school_idempotency_key" ON "school_ops"."workflow_runs"("school_id","idempotency_key");
CREATE INDEX "workflow_runs_school_status_idx" ON "school_ops"."workflow_runs"("school_id","status","created_at");
CREATE UNIQUE INDEX "workflow_step_runs_run_position_key" ON "school_ops"."workflow_step_runs"("workflow_run_id","position");
CREATE INDEX "workflow_step_runs_status_lease_idx" ON "school_ops"."workflow_step_runs"("status","lease_until");
CREATE UNIQUE INDEX "approval_tasks_step_key" ON "school_ops"."approval_tasks"("workflow_step_run_id");
CREATE INDEX "approval_tasks_school_status_idx" ON "school_ops"."approval_tasks"("school_id","status","created_at");
CREATE INDEX "outbox_events_status_lease_idx" ON "school_ops"."outbox_events"("status","lease_until","created_at");
CREATE UNIQUE INDEX "command_receipts_service_command_key" ON "school_ops"."command_receipts"("service","command_id");
CREATE UNIQUE INDEX "idempotency_records_scope_key" ON "school_ops"."idempotency_records"("scope","key");
CREATE INDEX "audit_events_school_created_idx" ON "school_ops"."audit_events"("school_id","created_at");

ALTER TABLE "school_ops"."school_memberships" ADD CONSTRAINT "school_memberships_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."role_grants" ADD CONSTRAINT "role_grants_membership_fkey" FOREIGN KEY ("membership_id") REFERENCES "school_ops"."school_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "school_ops"."student_profiles" ADD CONSTRAINT "student_profiles_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."student_profiles" ADD CONSTRAINT "student_profiles_membership_fkey" FOREIGN KEY ("membership_id") REFERENCES "school_ops"."school_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."guardian_relationships" ADD CONSTRAINT "guardian_relationships_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."guardian_relationships" ADD CONSTRAINT "guardian_relationships_guardian_fkey" FOREIGN KEY ("guardian_membership_id") REFERENCES "school_ops"."school_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."guardian_relationships" ADD CONSTRAINT "guardian_relationships_student_fkey" FOREIGN KEY ("student_profile_id") REFERENCES "school_ops"."student_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."roster_import_jobs" ADD CONSTRAINT "roster_import_jobs_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."workflow_runs" ADD CONSTRAINT "workflow_runs_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_run_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "school_ops"."workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "school_ops"."approval_tasks" ADD CONSTRAINT "approval_tasks_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."approval_tasks" ADD CONSTRAINT "approval_tasks_run_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "school_ops"."workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "school_ops"."approval_tasks" ADD CONSTRAINT "approval_tasks_step_fkey" FOREIGN KEY ("workflow_step_run_id") REFERENCES "school_ops"."workflow_step_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "school_ops"."outbox_events" ADD CONSTRAINT "outbox_events_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "school_ops"."audit_events" ADD CONSTRAINT "audit_events_school_fkey" FOREIGN KEY ("school_id") REFERENCES "school_ops"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
