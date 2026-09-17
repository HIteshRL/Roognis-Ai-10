-- Additive provenance for question-time PDF visual grounding. Images, source
-- bytes, prompts, and provider payloads are intentionally never persisted.
ALTER TABLE "ai_db"."messages"
  ADD COLUMN IF NOT EXISTS "source_page" INTEGER,
  ADD COLUMN IF NOT EXISTS "request_id" UUID,
  ADD COLUMN IF NOT EXISTS "inference_metadata" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_session_id_request_id_key"
  ON "ai_db"."messages"("session_id", "request_id");
