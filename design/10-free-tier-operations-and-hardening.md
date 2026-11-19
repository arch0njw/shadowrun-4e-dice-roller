# 10 Free-Tier Operations and Hardening

Status: draft. Depends on: 09. Individual items can be pulled forward.

This story covers what keeps a free deployment healthy: living inside the daily limits, backups without managed services, checking rolls without server-side physics, and the usual security and lifecycle work. A backlog follows.

## A. Free-limit handling

The free plan fails closed. When a daily limit is reached, operations return errors until 00:00 UTC (7 PM US Eastern in winter, 8 PM in summer). A game night can cross that moment.

Requirements:
1. Map limit errors to one error code. The Worker and the Durable Object catch the platform's limit errors (record the exact error texts during the story 01 echo spike and the story 07 budget test) and return `{ "error": "free_limit_reached" }` with HTTP 503 or a WebSocket `error` frame.
2. Client behavior on that code: a banner "The free daily limit is used up. Shared rolls resume at 7 PM Eastern. You can keep rolling locally." with the actual local reset time computed from 00:00 UTC. Roll buttons switch to local-only mode (Solo behavior from 00), clearly labeled "not shared".
3. Never lose a result silently. If a shared roll fails mid-way because of the limit, the roller keeps the result on their own tray with a "not shared" tag.
4. Reduce consumption where cheap: spectator audit messages (below) are batched into one frame per roll, the client sends no application heartbeat while the tab is hidden, and the `state` payload on reconnect carries only the first log page.
5. Operator visibility: the admin console links to the Cloudflare analytics page. A small admin panel shows today's roll count per team from each object's own `rolls` table (one RPC per active team, on demand only).
6. A usage test in CI replays a recorded "heavy night" (5 teams, 200 rolls each) against `dev` and records Durable Object requests, rows written and duration, and fails if projected daily use exceeds 25 percent of the limits.

Acceptance: forcing the error code in `dev` (feature flag) shows the banner, keeps Solo rolling working, and clears when the flag is removed. The heavy-night test passes.

## B. Backups without managed backups

- D1 holds the data that matters (users, roles, teams, profiles, audit). A nightly GitHub Actions job runs `wrangler d1 export` against `prod`, encrypts the file with `age` using a public key stored in the repo, and uploads it as a workflow artifact kept 14 days. Do not commit exports to the repository, even a private one.
- Also check whether D1 point-in-time restore is available on the free plan and document the restore commands in the runbook.
- Durable Object roll data is intentionally not backed up. It expires in 30 days anyway. State this in the privacy note and the runbook.
- Quarterly restore drill: restore the latest export into `dev` and sign in.

Acceptance: the nightly job succeeds three nights in a row, and a restore into `dev` produces a working copy with the same users and teams.

## C. Checking rolls without server-side physics

The free CPU budget cannot run a headless simulation of 30 dice per roll. Instead:

1. The server-issued seed (07) already stops the roller from choosing the throw.
2. Every spectator's simulation produces face values independently. After settling, each spectator sends `roll.audit { rollId, hash }` where `hash` is a short digest of its sorted `(dieId, value)` pairs.
3. The object compares audits with the roller's reported values. If at least two spectators agree with each other and disagree with the roller, the roll is marked `disputed`, shown with a badge in the log for team members, and the roll's seed and values are stored for review. The roller's values remain the displayed result unless the GM resolves the dispute.
4. A single disagreeing spectator is recorded as a `snap` metric only, since cross-browser differences are the more likely cause.
5. Hidden rolls (09) are never audited because nobody else receives them.
6. Limit: one audit frame per spectator per roll, which is a small share of the request budget (see README).

Acceptance: a client modified to report wrong faces causes a `disputed` mark when two or more honest spectators are present. Honest clients on different browsers produce a dispute rate under 0.1 percent in the 10,000 roll determinism test.

## D. Rate limiting and abuse

- Sign-in attempts: a small `RateLimiter` Durable Object keyed by a hash of the client IP allows 10 attempts per minute. Cloudflare's own rate limiting products are not assumed to be free.
- WebSocket connects: 20 per minute per user, at most 6 concurrent sockets per user (oldest closed with 1008).
- Profile and admin write limits as in 03 and 05.
- Frame size limit 16 KB, message rate limits inside the team object (07).

## E. Data protection and lifecycle

- User deletion: anonymize in place. Email becomes a tombstone address, `auth_sub` and `avatar_url` cleared, name set to "Former runner". Roll rows in team objects keep a snapshot name until retention removes them. A deletion also asks each of the user's team objects to replace `roller_name` for that user with "Former runner".
- User data export: JSON of profile, team memberships and rolls within retention.
- Session hygiene: delete expired and revoked sessions older than 7 days opportunistically during sign-in (bounded delete, 100 rows).
- Dependency updates: weekly automated pull requests, high-severity advisories fail CI.

## F. Security review items

- WebSocket threat model: cross-site WebSocket hijacking guarded by `Origin`, message size and rate limits, per-connection quotas.
- Cookie scope check: no endpoint accepts the session cookie from a cross-site context.
- Run the 09 leak audit in CI on every merge.
- Tighten the Content Security Policy, starting in report-only.
- Rotate the Cloudflare API token and the Google client settings annually, with a runbook entry.

## G. Scaling beyond free

If daily limits become a problem, the paid Workers plan raises limits at a low monthly price (check current pricing before committing). Nothing in the design changes. The team-object model scales by adding teams, not by adding servers. If you leave Cloudflare, the portable pieces are the client, the protocol, the SQL schemas, and the seed derivation. The Durable Object hub would be replaced by a Node WebSocket server like the one in the AWS set.

## H. Product backlog (not scheduled)

- Roll statistics per user and per team.
- Saved rolls and presets (initiative, named pools).
- Extended tests accumulating hits across rolls.
- Roll labels and comments in the log.
- Server-tracked Edge points per member per team, so Refresh and spend survive reloads and cannot be misreported.
- Per-viewer setting "show everyone in my skin".
- Sound and haptics with a mute control.
- Co-GMs.
- Shareable read-only log link.
- Installable web app with offline Solo mode.
- Email invitations.
- Localization.
- Accessibility pass: a text description of dice on the table, large-print mode, shape-coded hit markers.

## I. Quality gates before calling it v1

1. All acceptance criteria in 01 to 09 pass in `prod`.
2. The README budget table has no unverified rows, and the heavy-night test passes.
3. The determinism measurement from 07 is documented with real numbers.
4. The 09 leak audit runs in CI on every merge.
5. A backup has been restored successfully.
6. Runbook entries exist for admin lockout, bad deploy, restore, token rotation, user deletion, and hitting the daily limit.
7. Two real teams have played a full session with no lost rolls and no hidden-roll leak.
