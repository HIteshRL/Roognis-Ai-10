-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth_db";

-- CreateEnum
CREATE TYPE "auth_db"."Role" AS ENUM ('student', 'teacher', 'parent');

-- CreateTable
CREATE TABLE "auth_db"."schools" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_db"."users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "auth_db"."Role" NOT NULL,
    "school_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_db"."parent_student" (
    "parent_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,

    CONSTRAINT "parent_student_pkey" PRIMARY KEY ("parent_id","student_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "auth_db"."users"("email");

-- CreateIndex
CREATE INDEX "users_school_id_role_idx" ON "auth_db"."users"("school_id", "role");

-- AddForeignKey
ALTER TABLE "auth_db"."users" ADD CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "auth_db"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_db"."parent_student" ADD CONSTRAINT "parent_student_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "auth_db"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_db"."parent_student" ADD CONSTRAINT "parent_student_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "auth_db"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

