# 08 Roll Log and 30 Day Retention

Status: draft. Depends on: 07. Blocks: 09.

## Goal

Every roll in a team is stored and shown in a log that every member of the team can see. Rolls are kept for 30 days, then deleted automatically. The behavior matches the AWS 08. The difference is where the data lives: in each team's Durable Object, purged by an alarm.

## In scope

Log API and live updates, log UI, entry detail and "show on my tray", retention alarm and its safety rails, privacy statement.

## Out of scope

Visibility rules for hidden rolls (09, but the query layer here already filters by visibility), export, statistics.

## What is stored

The `rolls` table in the team Durable Object (07) is the log. No new table is needed. Each entry shows who rolled, when, the label (`9d6`, `9+3d6 Push the Limit`, `Second Chance`), the result (hits, ones, total, exploded, glitch, critical glitch, threshold outcome), the skin, and the final dice values for the detail view. Abandoned rolls are hidden from the log and kept for the same 30 days.

## Read path

- Log reads go to the Durable Object through the Worker: `GET /api/teams/:id/rolls?before=<seq>&limit=50` and `GET /api/teams/:id/rolls/:rollId`. The Worker checks membership (06), then calls `TeamRoom.listRolls(viewer, before, limit)`.
- The object returns rows through `visibleRolls(viewer)` only. No other function reads `rolls`. In this story it returns `visibility = 'team'` rows, and 09 extends it for the GM.
- The Worker adds current avatars by fetching the distinct `user_id` values from D1 in one query. The stored `roller_name` is a snapshot and is not changed by renames.
- Live updates arrive through the existing `roll.complete` events from 07. The first page also arrives in the `state` message on connect.
- Pagination cursors are `seq` values of returned rows. The API never returns `seq - 1`, so gaps are not exposed.

## Retention

- Policy: delete rows where `created_at` is older than `ROLL_RETENTION_DAYS` (30). Applies to archived teams too.
- Mechanism: a Durable Object alarm, not a Worker cron. After each insert the object ensures an alarm exists for the next 03:15 UTC. When the alarm fires it deletes in batches of 500 rows ordered by `created_at`, then:
  - if rows remain (newer ones), sets the next alarm for the following 03:15 UTC;
  - if the table is empty, sets no alarm, so a dormant team costs nothing and the object can be evicted.
- The alarm counts as a Durable Object request. At 50 teams that is at most 50 requests per day, which is negligible.
- If `latest_roll_id` points to a purged roll, the handler clears it and the table state becomes empty.
- Safety rail: if one purge would delete more than 50 percent of all rows in the table and more than 200 rows, the handler skips the delete, logs an error, and retries at the next alarm. An operator can force it through an admin-only RPC. This guards against a bad clock or a bad config value.
- `ROLL_RETENTION_DAYS` is read from Worker vars and validated at start-up. Changing it takes effect at the next alarm.
- Deleting a team permanently (admin only) calls `ctx.storage.deleteAll()` on its object.
- Cloudflare does not keep backups of Durable Object data for you, so purged data is gone. State this in the privacy note.

## Log UI

Same as the AWS 08: panel below the result card for the active team (Solo keeps the in-memory log), entry rows with avatar, name, label, large hit count, Glitch or Critical glitch tag, relative time with absolute time on hover and focus, "Load older", All and Mine filters, empty state "No rolls in the last 30 days.", the line "Rolls are kept for 30 days.", detail view with final dice and breakdown, "Show on my tray" which renders the stored final state locally without any message to the server, and an accessible live region that announces new rolls.

## Acceptance criteria

1. After A and B each roll twice, all four entries appear in the same order for A, B and a third member C.
2. A member who joins later sees the existing log, up to 30 days.
3. A non-member requesting the log gets 403.
4. An entry older than 30 days is deleted by the alarm and one 29 days old stays, using seeded timestamps in a test.
5. The purge is idempotent, can run twice back to back, and leaves `latest_roll_id` valid or empty.
6. The safety rail triggers on a dataset that would lose more than 50 percent in one run.
7. Paging with `before=<seq>` neither repeats nor skips entries while new rolls arrive.
8. "Show on my tray" renders stored state with the stored skin and sends no WebSocket message.
9. Abandoned rolls never appear in the UI.
10. Setting `ROLL_RETENTION_DAYS` to 7 in `dev` changes the cutoff at the next alarm.
11. A team with no rolls in 30 days has no pending alarm after its last purge.

## Test plan

Query tests with a time-travel fixture, alarm tests for batch deletion and the safety rail, API tests for pagination boundaries, and a UI test for live arrival, load older, and detail.

## Privacy note (copy to the in-app About page)

Rolls, including who rolled and the dice results, are visible to every member of the team and are deleted after 30 days. Display names stored with rolls are not updated when a user renames themselves.
