# 07 Live Shared Rolls (Durable Object WebSocket Hub)

Status: draft. Depends on: 04, 06. Blocks: 08, 09.

## Goal

When one member of a team rolls, every connected member sees the same roll happen on their own tray in real time. The finished roll stays on every tray until someone in that team rolls again. Members who connect later see the latest roll at rest.

This story differs from the AWS 07 in two ways. The hub is a hibernating Durable Object instead of a Node process, and the server now issues the random seed for each roll, so the roller cannot pick the throw.

## In scope

- Authenticated WebSocket through the Worker to the team's Durable Object.
- Presence, the per-team roll lock, and the roll protocol.
- Deterministic replay of dice physics from a server-issued seed.
- Minimal roll storage in the Durable Object (log UI and purge are 08).
- The roller's skin shown to spectators.
- A `visibility` field on every roll, always `team` in this story.

## Out of scope

Hidden GM rolls (09), log UI and purge (08), spectator checking and quota handling (10).

## Design summary

- Randomness is server-side. The Durable Object creates a 64-bit seed for every roll using `crypto.getRandomValues`.
- Every browser derives every die's starting position, velocity and spin from the seed with a shared PRNG, and runs the same fixed-step physics. The roller reports the resulting face values. Spectators run the same simulation, compare, and snap any die that disagrees.
- Messages stay tiny because they carry a seed and a few numbers, not per-die vectors. Incoming messages are the metered ones on the free plan, so small and few is the goal.
- One active public roll per team at a time (the lock).

## Changes to the dice engine (required for determinism)

The current engine (00 section 4) is not deterministic across machines. Before this story ships, change it as follows:

1. Fixed stepping only. Replace `world.step(1/60, dt, 3)` with an accumulator that always calls `world.step(1/60)` a whole number of times. Rendering interpolation is optional. Results must never depend on frame rate.
2. Settling is counted in steps, not seconds. A wave is settled after 20 consecutive steps below the speed thresholds, with a hard limit of 480 steps.
3. No `Math.random`. All randomness comes from `shared/rng.ts`: xoshiro128** seeded from the roll seed and wave index with a fixed hash (SplitMix32). This includes initial orientation, throw speed, the nudge applied to cocked dice, and respawn positions.
4. Canonical arena. Physics uses a fixed 20 by 12 world on every device, regardless of screen. The camera fits the view. On portrait screens the tray view is rotated 90 degrees instead of reshaping the arena (00 section 5 is superseded). Decide the portrait presentation before implementation.
5. Fixed body creation order. Dice are created in ascending `dieId` so solver ordering is identical everywhere.
6. Stay on one physics library version for all clients (pinned in the bundle).

Derivation of a die's throw from the seed: `rng = xoshiro(hash(seed, waveIndex))`, then for `dieId` in ascending order draw in a fixed sequence: layout jitter, orientation (three values), speed, cross speed, upward speed, angular velocity (three values). Layout positions are a function of die count and index, as in 00.

Known risk: transcendental functions (`sin`, `cos`) can differ in the last digit between JavaScript engines. If the cross-browser determinism test (below) shows face disagreements, keep the seed protocol but make the snap authoritative and consider a deterministic lookup-table implementation of the few trig calls used.

## Connection

- Route `wss://<host>/ws/:teamId`. The Worker validates the session cookie, the `Origin`, and team membership (06 helper), then forwards the upgrade to `TEAM.get(idFromName(teamId))` with verified identity headers (`X-User-Id`, `X-Display-Name`, `X-Team-Role`, `X-Skin-Id`) that only the Worker can set. The object is not reachable from the internet except through the Worker.
- The object uses the Hibernation API: `ctx.acceptWebSocket(ws)` and `ws.serializeAttachment({ userId, name, role, skinId })`. Attachments survive hibernation. No per-connection state lives only in memory.
- Heartbeat: client sends the text frame `ping` every 25 seconds. The object registers `setWebSocketAutoResponse` for `ping` to `pong`, which is answered without waking the object. A client without a `pong` in 60 seconds reconnects.
- Reconnect backoff 0.5, 1, 2, 4, 8, 15 seconds with jitter. On reconnect the client asks for current state (below) instead of replaying missed events.
- Close codes: 1000 normal, 1008 policy, 1012 service restart (deploy), 4001 session revoked or user disabled, 4002 removed from team, 4003 team archived.
- Messages are JSON text frames up to 16 KB, validated with zod from `/shared/protocol.ts`. Unknown types close with 1008.
- One socket per tab. A user may have several tabs.

## Messages

Client to server:
- `hello { }` request for state after connect.
- `roll.request { rollId, kind, pool, edge, threshold, parentRollId?, visibility }`
- `roll.wave { rollId, index, values }` (Push the Limit continuation)
- `roll.complete { rollId, values, finalTransforms, result }`
- `roll.abort { rollId }`
- `ping` text frame.

Server to client:
- `state { members, presence, table, log }` where `table` is the latest visible roll at rest or `null`, and `log` is the first page (08).
- `presence { userId, online }`
- `roll.begin { rollId, userId, name, skinId, kind, pool, edge, seed, parentRollId, removed }`
- `roll.wave { rollId, index, count }`
- `roll.complete { rollId, roll }`
- `roll.abort { rollId, reason }`
- `error { code, message, refT }`
- `pong` text frame.

`values` is an array of `[dieId, value]`. `finalTransforms` is `[dieId, x, y, z, qx, qy, qz, qw]`. `dieId` is a small integer unique within a roll, assigned in creation order, with `src` (`pool`, `edge`, `explode`) derivable from the id and kind.

## Roll flow

1. The roller's client sends `roll.request`. It does not start throwing yet.
2. The object validates (below), takes the lock, creates the seed, stores a `rolling` row, sets an alarm for 25 seconds as the roll timeout, and broadcasts `roll.begin` with the seed to every connected member, including the roller.
3. Every client builds the world, derives wave 0 from `seed`, and simulates. The roller's start is delayed by one round trip, which is intended.
4. For Push the Limit, when the roller's wave settles it counts the sixes and sends `roll.wave { index: k+1, values: <wave k values> }`. The object checks the index, checks `values` has the right dice, counts the sixes itself, and broadcasts `roll.wave { index: k+1, count }`. Everyone derives wave k+1 from `hash(seed, k+1)` and spawns `count` dice. Repeat until no sixes, with the caps from 00 (12 waves, 160 dice).
5. When the last wave settles, the roller sends `roll.complete` with all values and final transforms. The object recomputes the result from the values with `rules/sr4.ts`, stores it, clears the lock and the alarm, sets `latest_roll_id`, and broadcasts `roll.complete`.
6. Spectators, when their local simulation settles, compare their face values with the `roll.complete` values and snap mismatches over 150 ms. They also place any die that rests more than 0.25 units from the reported transform. Late `roll.complete` and local settle can happen in either order.
7. Second Chance: `roll.request` with `kind: second` and `parentRollId` equal to the team's latest complete roll by the same user. The object checks that, sets `removed` to the ids of non-hit dice from the parent, and broadcasts `roll.begin` with a new seed. Everyone removes those dice, keeps the rest as static bodies, and throws replacements derived from the new seed.
8. `push` and `second` are mutually exclusive on one test, as in 00.

## Server rules (in the Durable Object)

On `roll.request`:
1. The sender's attachment says they are a member and the team is not archived.
2. No lock is held, or the held lock is older than 25 seconds (stale locks are cleared and the old roll marked `abandoned`). Otherwise reply `error { code: "roll_in_progress" }`.
3. Limits: pool 1 to 30, edge 0 to 7, total dice 160, finite numbers.
4. Rate: one request per user per second and 30 per minute, tracked in the object.
5. `skinId` comes from the verified header, not from the client.
6. `visibility` must be `team` in this story. 09 enables `gm`.

On socket close or `roll.abort` mid-roll: mark `abandoned`, clear lock and alarm, broadcast `roll.abort`. The alarm handler does the same on timeout. Spectators clear in-progress dice and restore the last complete state.

Lock state and `latest_roll_id` live in the object's SQLite storage, not in memory, so hibernation never loses them. Do not use `setTimeout` for timeouts. A pending timer keeps the object awake and billed. Use `ctx.storage.setAlarm`.

## Storage (Durable Object SQLite)

```sql
create table rolls (
  id           text primary key,
  seq          integer not null,
  user_id      text not null,
  roller_name  text not null,
  kind         text not null check (kind in ('normal','push','second')),
  parent_id    text,
  visibility   text not null default 'team' check (visibility in ('team','gm')),
  status       text not null default 'rolling' check (status in ('rolling','complete','abandoned')),
  skin_id      text not null,
  pool         integer not null,
  edge         integer not null,
  threshold    integer not null default 0,
  seed         text not null,
  waves        text,       -- JSON: counts per wave
  result       text,       -- JSON
  final        text,       -- JSON: values and transforms
  created_at   integer not null,
  completed_at integer,
  revealed_at  integer
);
create index rolls_seq_idx on rolls (seq desc);
create table room_state (key text primary key, value text);
-- keys: lock_roll_id, lock_since, latest_roll_id, seq_counter
```

`seq` is a per-team counter incremented in the same transaction as the insert. Durable Object storage transactions are available through `ctx.storage.transactionSync`.

## Presence

Members are online if they have at least one open socket. The object computes presence from `ctx.getWebSockets()` and broadcasts changes. Shown as avatars with a ring in the header.

## Fan-out

All outgoing roll data passes through one function `broadcast(event, audience)` and one function `redact(event, viewer)`. In this story `redact` returns team events unchanged. 09 depends on there being no other path.

## State on connect and reconnect

On `hello` the object sends `state` with presence, the table roll at rest, and the first log page. This replaces event replay. A client that missed events never replays animations, it just shows the current resting state.

## Client changes

- `RealtimeClient` module with connection state machine and typed messages.
- `RollSession` with `LocalRoll` (Solo, as in 00) and `TeamRoll`.
- Roll buttons are disabled while another member is rolling, with the label "<name> is rolling".
- Connection indicator: connected, reconnecting, offline. When offline in a team, the Roll button offers "Roll locally (not shared)".
- Spectator throws use the same animation as the roller. Reduced-motion users jump to the final state.
- Header text "Last roll: <name>, <label>, <time ago>".

## Acceptance criteria

1. Two browsers, two members: when A rolls 9 dice, B sees the same throw begin within 500 ms of A's `roll.begin`, and both trays settle to the same faces.
2. Result card, hit rings and glitch badges match on both screens for 20 consecutive rolls including Push the Limit with explosions and Second Chance.
3. A third member who joins later sees the dice at rest and the result immediately, without animation.
4. The roll stays on all trays until someone rolls again. Reloading restores it.
5. While A is rolling, B cannot start a roll, even by sending the message directly.
6. Closing A's tab mid-roll aborts it for everyone within 5 seconds, or at the 25 second alarm at the latest.
7. A member removed from the team is disconnected with 4002 and receives no further events.
8. The server rejects unknown types, oversize frames, a pool of 31, non-finite numbers, and a team the user does not belong to.
9. A deploy drops sockets with 1012 and clients resync within 15 seconds without reload.
10. A roller cannot influence the throw: modifying the client to send a different seed has no effect because `roll.begin` is the only source of the seed.
11. The same seed and counts produce identical face values in Chrome, Firefox and Safari, for at least 99.9 percent of 10,000 recorded rolls. Disagreements are logged with the die ids.
12. The object hibernates between rolls (no duration charges while idle with open sockets).
13. Physics uses the canonical arena on every device. Rotating a phone does not rebuild physics.

## Test plan

- Protocol schema tests for every message type.
- Durable Object tests with simulated clients: lock contention, stale lock via alarm, abort on close, state on reconnect, team isolation.
- Determinism test: run recorded seeds in Node and in three browsers with Playwright, compare faces.
- Budget test: measure Durable Object requests, rows written and duration for 100 rolls with 6 clients, and compare with the README estimate.
- Manual: two devices on different networks, drop Wi-Fi on one mid-roll.

## Risks

- Cross-engine floating point differences. Mitigated by snapping, measured early.
- Portrait presentation of the canonical arena needs a design decision.
- Mobile browsers suspend sockets in the background, so reconnect and resync must be reliable.
- Free-plan duration or CPU limits may differ from the budget. Verify with the budget test.
