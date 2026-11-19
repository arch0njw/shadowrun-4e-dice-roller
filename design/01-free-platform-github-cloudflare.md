# 01 Free Platform: GitHub and Cloudflare

Status: draft. Depends on: 00. Blocks: everything else.

## Goal

Move the single-file page into a project, deploy it for free on a Cloudflare Worker from GitHub Actions, and prove the three platform pieces the rest of the plan depends on: D1, Durable Objects with hibernating WebSockets, and the deploy pipeline. No user-visible behavior changes. The dice roller works as described in 00.

## In scope

- Repository layout, TypeScript, build tooling.
- Behavior-preserving refactor of the page into modules (same as the AWS 01).
- Cloudflare account, Worker with static assets, D1 databases, Durable Object class.
- CI/CD to `dev` and `prod`.
- Health endpoint, migrations, operator runbook.
- WebSocket echo spike through a hibernating Durable Object.
- Verification of the unverified free limits in the README budget.

## Out of scope

Authentication (02), any user data, the real roll protocol (07).

## Repository layout

```
/client      Vite + TypeScript SPA (the dice roller)
/worker      Cloudflare Worker (API, auth, routing) and Durable Object classes
/db          D1 SQL migrations, numbered, forward-only
/shared      Types, zod schemas, rules module, deterministic RNG
/specs       These documents
/scripts     Operator scripts (user:add, db:shell)
/.github     Workflows
```

npm workspaces. Node version pinned in `.nvmrc`. ESLint, Prettier, Vitest.

## Client refactor (no behavior change)

As in the AWS 01: split into `dice/engine.ts`, `dice/render.ts`, `dice/skin.ts`, `rules/sr4.ts`, `ui/*`. Bundle three and cannon from npm, self-host fonts, remove CDN script tags. Unit test `rules/sr4.ts`.

One addition for story 07: keep `dice/engine.ts` free of `Math.random`, wall-clock reads, and frame-time dependence from the start (see 07 section "Changes to the dice engine"). In this story the engine may still be driven by a random seed chosen locally, so the behavior is unchanged.

## Cloudflare setup

`wrangler.toml` (names are examples):

```toml
name = "shadowrun-dice"
main = "worker/src/index.ts"
compatibility_date = "2026-11-01"

[assets]
directory = "client/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/ws/*"]

[[d1_databases]]
binding = "DB"
database_name = "shadowrun-dice-prod"
database_id = "<from wrangler d1 create>"
migrations_dir = "db/migrations"

[[durable_objects.bindings]]
name = "TEAM"
class_name = "TeamRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TeamRoom"]

[vars]
ROLL_RETENTION_DAYS = "30"
```

Notes:
- The free plan only supports SQLite-backed Durable Objects, so the class is declared with `new_sqlite_classes`.
- `dev` is a second Worker (`shadowrun-dice-dev`) with its own D1 database, defined as a wrangler environment.
- The Worker serves `/api/*` and `/ws/*` itself and everything else from static assets with SPA fallback.
- Security headers (HSTS, `X-Content-Type-Options`, `Referrer-Policy`, CSP) are set in the Worker response for HTML and through a `_headers` file in the assets directory. The CSP is the starting policy from the AWS 01 without the CloudFront and `wss://app.<domain>` entries, using `'self'` instead. Google entries come in story 02.

## Worker skeleton

- `GET /api/health` returns `{ "ok": true, "version": "<git sha>", "db": true|false }`. The `db` field runs `select 1` against D1.
- Request routing in one `router.ts`. JSON error shape `{ "error": "<code>", "message": "..." }`.
- Config via `[vars]` and secrets, validated with zod at first request.
- Keep handlers light. The free plan has a small CPU budget per request (unverified, about 10 ms), so no heavy work in the Worker. Measure in this story.

## Durable Object echo spike (delete or keep behind a flag after 07)

- `TeamRoom` accepts WebSockets using the Hibernation API (`ctx.acceptWebSocket`), echoes text frames, and uses `setWebSocketAutoResponse` for `ping` to `pong`.
- `GET /ws-echo` upgrades and forwards to one fixed Durable Object.
- Verify: two browsers see each other's echoed messages; the object hibernates when idle (confirm by observing that duration billing stops, using the dashboard metrics); a deploy drops sockets and the client reconnects; a 25 second client ping keeps the socket open for 10 minutes.
- Record in the PR: measured CPU per message and any limit error text, so story 10 can map real errors to user messages.

## D1 and migrations

- Migration `0001_init.sql` creates a `schema_info` table only. Later stories add tables.
- `wrangler d1 migrations apply` runs in the pipeline before the Worker is deployed.
- All migrations must be backward compatible with the previous Worker version, since a rollback does not roll back the database.
- D1 has no interactive transactions. Multi-statement writes use `db.batch([...])`, which is atomic. State this rule in the contributing guide.

## CI/CD (GitHub Actions)

- On pull request: install, lint, typecheck, unit tests, client build, `wrangler deploy --dry-run`.
- On merge to `main`: apply `dev` migrations, deploy `dev`.
- On tag `v*`: GitHub environment `production` with manual approval, then apply `prod` migrations and deploy `prod`.
- Secret: one Cloudflare API token scoped to the account with Workers, D1 and Durable Objects edit permission, stored as a GitHub environment secret. No other secrets are needed in this story.
- Cloudflare provides a Workers Builds git integration as an alternative. This spec chooses Actions so deployment, migrations and tests live in one workflow.

## Local development

- `npm run dev` runs Vite and `wrangler dev` (local D1 and Durable Object emulation) with `/api` and `/ws` proxied.
- A seed script creates a local admin user (used from 02 on).

## Operator runbook (`docs/runbook.md`)

- Run SQL on production D1: `npx wrangler d1 execute shadowrun-dice-prod --remote --command "<sql>"`, or the dashboard console.
- Roll back a bad deploy: `npx wrangler rollback`, or redeploy the previous tag.
- Restore D1 (check whether point-in-time restore is available on the free plan and document the exact command).
- Rotate the Cloudflare API token.

## Acceptance criteria

1. The deployed `workers.dev` URL serves the dice roller and all 00 acceptance items pass.
2. `/api/health` returns 200 with `db: true`.
3. The echo spike passes the four verification points above, on desktop and a phone.
4. A merge to `main` deploys `dev` with no manual steps in under 10 minutes. A tag deploys `prod` after approval.
5. A migration in a PR is applied before the new Worker version serves traffic.
6. The README budget table is updated: every "unverified" row now has a verified value and a source link, or a note that it could not be confirmed.
7. Total monthly cost shown in the Cloudflare and GitHub billing pages is 0.
8. Security headers are present on the HTML response.

## Test plan

- Unit tests for `rules/sr4.ts` as in the AWS 01.
- Worker tests with Miniflare or `vitest-pool-workers` for routing and health.
- Echo spike scripted with two Playwright pages.

## Risks

- Bundling cannon.js 0.6.2 with Vite may need configuration, or switch to `cannon-es` and re-verify settling.
- Free-plan limits change. The budget table is a snapshot.
- A Cloudflare account may require additional verification. Confirm no payment method is needed to stay on the free plan.
