#!/usr/bin/env sh
set -eu

# Validate interpolation and Compose structure without writing a .env file or
# contacting a registry. These are deliberately non-secret, syntactically
# valid values used only for static validation.
export ROOGNIS_BASE_DOMAIN="validation.example"
export ACME_EMAIL="ops@validation.example"
export POSTGRES_PASSWORD="validation-only-postgres-password"
export JWT_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export INTERNAL_SERVICE_TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export NEO4J_PASSWORD="validation-only-neo4j-password"
export LOCAL_LLM_BASE_URL="https://llm.validation.example/v1"
export LOCAL_LLM_API_KEY="validation-only-provider-key"
export LOCAL_LLM_MODEL="validation-model"
export EMBEDDING_PROVIDER_URL="http://embedding.validation.example:11434"
export OLLAMA_EMBEDDING_MODEL="nomic-embed-text"

digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"
for service in TRAEFIK POSTGRES REDIS CHROMADB NEO4J; do
  eval "export ${service}_IMAGE=registry.validation.example/platform/${service}@${digest}"
done
for service in AUTH AI ANALYTICS QUIZ PRACTICE DISCOVER REPORTING RAG LMS KG GNN DECISIONS PRIVACY PARENT_PORTAL STUDENT_PORTAL TEACHER_PORTAL; do
  eval "export ${service}_IMAGE=registry.validation.example/roognis/${service}@${digest}"
done

docker compose --env-file .env.example -f platform.compose.yaml config --quiet
docker compose --env-file .env.example -f platform.compose.yaml -f platform.build.compose.yaml config --quiet

printf '%s\n' 'Compose topology and local integration-build overlay are structurally valid.'
