# Roognis platform infrastructure

This is an independently versioned deployment repository for the repositories
beside it. It is **not a monorepo** and it does not own application source,
schemas, or application migrations. It owns the runtime topology, ingress,
image selection, environment wiring, operational guardrails, and release
evidence.

`platform.compose.yaml` is a production deployment baseline: all application
images are required immutable digest references. `platform.build.compose.yaml`
is an explicitly separate local integration overlay. Do not use that overlay to
approve or promote a production release.

## Deliberate deployment scope

The topology deploys Auth, AI, Analytics, Quiz, Practice, Discover, Reporting,
RAG plus its worker, LMS, KG, the knowledge/preference GNN lanes and trainer,
Decisions, Privacy, the three portals, Postgres, Redis, Chroma, Neo4j, and
Traefik.

**PSV is not present in either Compose file.** This is intentional: PSV's own
source says it is not approved for production and it can issue student/guardian
campaigns. The platform sends empty `PSV_SERVICE_URL` values to dependent
services; no `psv` DNS name is created. Reporting is explicitly configured with
`PSV_ENABLED=false`, so it returns its documented partial academic summary and
limitation rather than re-enabling PSV. A release manager must not add PSV back
until the product owner signs the service, its intervention policy, delivery
semantics, audit evidence, and rollback procedure.

**School Ops is also quarantined from the production topology.** Auth requires
an Auth-owned School before it can create an account, while School Ops currently
creates and owns a separate School record and membership graph. Starting the
School Ops server, outbox worker, or its migration would create divergent tenant
authorities; none of them appear in the production Compose file, image inputs,
or release services catalog. The local integration overlay excludes it as well,
so it cannot be mistaken for an integration-ready component.

School Ops can re-enter only after a versioned bootstrap contract is implemented
and contract-tested end to end:

1. A single idempotent school-bootstrap command accepts an external
   correlation/idempotency key and creates (or resolves) the authoritative Auth
   school identity.
2. The same saga creates the School Ops school projection and administrator
   membership using the Auth school ID as the tenant key; it must not generate a
   competing tenant ID.
3. An outbox event or compensatable step records completion for both owners,
   supports retry without duplicate schools/memberships, and reports a durable
   partial-failure state to an operator.
4. Auth account creation and School Ops authorization/membership lookup use the
   same tenant ID. The contract suite must cover successful bootstrap,
   idempotent retry, downstream failure/recovery, unauthorized access, and
   reconciliation of any existing divergent records.

Until those conditions are qualified with authenticated integration tests, the
School Ops source repository remains an isolated non-production capability.

## Boundaries and security controls

- Only Traefik publishes ports (`80` and `443`). Databases and application
  services have no host-published ports.
- `roognis-private` is an internal Docker network for service-to-service and
  data-plane traffic. `roognis-edge` contains Traefik and the routable portals
  or APIs. Traefik discovery is opt-in only.
- Public routes are limited to the versioned portal host names and existing
  `/api/{service}` prefixes. Internal health and service-only paths are not
  exposed by a router.
- Every app container drops Linux capabilities, uses `no-new-privileges`, has
  a resource reservation/limit, restart policy, and a health check. Portals
  additionally have read-only roots and a temporary filesystem.
- Postgres uses SCRAM initialization and is not publicly reachable. Named
  volumes are durable state: backup and restore qualification is mandatory
  before real learner data is admitted.
- The current services accept one shared `INTERNAL_SERVICE_TOKEN`. That is a
  compatibility constraint, not the final least-privilege model. Replace it
  with workload-specific identity and short-lived credentials before a strict
  microservices production declaration.

The split applications still use a shared Postgres instance and schemas. The
platform preserves that existing contract so it can be integrated safely; it
does **not** redefine it as database-per-service microservices. Removing the
Analytics-to-Auth schema read and moving to service-owned stores remains a
separate application migration.

## Release procedure

1. Each owner repository runs its own CI, builds a signed image, scans it, and
   records both the repository commit and immutable image digest in
   [release-catalog.yaml](release-catalog.yaml). Never release from a local
   build context.
2. Reproduce every owner image from its committed runtime requirements and run
   that service's test suite before assigning a digest. This platform cannot
   make a dependency declaration, a Dockerfile, or a model-provider URL into
   runtime proof.
3. Copy `.env.example` to `.env` in the deployment environment and inject
   real values using the deployment secret manager. Do not store `.env` in Git,
   an image, or a portal build artifact. Replace every image entry with a full
   `registry/path@sha256:<64-hex>` reference.
4. Provision DNS for `parent`, `student`, and `teacher` below
   `ROOGNIS_BASE_DOMAIN`, and ensure the host can receive TLS challenges on
   port 443. The Traefik dashboard deliberately stays disabled.
5. Run `./scripts/validate-compose.sh`. It is structural validation only: it
   neither contacts a registry nor proves credentials, database migrations,
   external model availability, or service behavior.
6. In the deployment environment, run `docker compose -f platform.compose.yaml pull`
   followed by `docker compose -f platform.compose.yaml up -d --remove-orphans`.
   Do not add `platform.build.compose.yaml` in this step.
7. Wait for one-shot Node migration containers to finish successfully, then
   inspect `docker compose ps` and container logs. Do not run arbitrary
   `prisma db push` against a production database.
8. Perform the release acceptance set against fresh teacher-created content:
   teacher publish, RAG ingest and source-bound cited retrieval, student
   authorization and coursework, parent guardian redemption/reporting,
   role portal checks, plus recovery of a failed worker. The compose health
   checks are necessary but insufficient proof.

## External prerequisites intentionally not faked by Compose

`LOCAL_LLM_BASE_URL` and `EMBEDDING_PROVIDER_URL` are external, qualified
provider endpoints. This repository intentionally does not start a pretend
DGX/vLLM/Ollama model container: an endpoint configured in YAML is not proof of
the advertised model, structured output behavior, GPU memory, saturation,
cancellation, or learner-data egress policy. Qualify those conditions before
enabling the dependent AI features.

RAG/LMS file volumes are an interim compatibility path. Object storage,
malware scanning, retention, encrypted backups, and a restore drill must be
implemented/qualified before handling real production submissions.

## CI ownership

The platform repository contains only topology validation because each source
repository has its own language/runtime, lock file, test command, and release
authority. A broad workflow copied into eight repositories would be cosmetic
and could falsely report cross-service readiness. Each owner must add a native
CI workflow that at minimum performs dependency installation, lint/typecheck,
unit tests, dependency audit policy, image build, image scan, and publishes a
signed digest for the catalog. Cross-service contract and authenticated E2E
tests belong in a dedicated integration stage that consumes those digests.

## Operations and rollback

- Roll back by changing only affected image digests in the release input,
  after confirming compatibility with the current schema version. Container
  rollback is not database migration rollback.
- Take encrypted, tested Postgres/Chroma/Neo4j/object-storage backups before
  every schema or release change. Restore into an isolated environment and
  prove an authorized read before calling the backup recoverable.
- Watch container restart counts, request errors/latency, database connections,
  RAG worker queue age/failures, outbox backlog, provider error rates, model
  latency, and auth failures. Central metrics, traces, alert routing, and a
  dead-letter operator workflow still need implementation before general
  availability.
- Do not deploy School Ops or configure an outbox delivery URL until its
  Auth-school/bootstrap saga is implemented, authenticated, and reconciled.
