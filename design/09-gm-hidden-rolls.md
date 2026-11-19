# 09 GM Hidden Rolls

Status: draft. Depends on: 07, 08. Blocks: 10.

## Goal

A GM can roll dice that players cannot see. Hidden is the default for every GM roll. The GM must explicitly choose to make a roll visible. The rules are the same as the AWS 09. This story restates them against the Durable Object design and explains where the privacy guarantee is enforced.

## In scope

`visibility` behavior for GM rolls, GM roll UI, redaction in the Durable Object, reveal, tests and a leak audit.

## Out of scope

Co-GMs, admin read access to hidden rolls, secret rolls by players, a placeholder such as "The GM rolled".

## Rules

1. Only the team's GM (`team_role = 'gm'` in that team) can create a hidden roll. Everyone else's rolls are always `team`.
2. For a GM, every new roll starts hidden. The visibility control resets to hidden after every roll.
3. A hidden roll is stored with `visibility = 'gm'` and is delivered only to the GM's own connections. No other connection receives any message about it, including other members, the admin, and nothing at all as a placeholder.
4. A hidden roll does not take the roll lock, so it cannot block players and cannot be blocked by them.
5. A hidden roll does not replace the shared table and does not touch `latest_roll_id`. The GM's tray shows it until the next public roll event arrives.
6. The hidden roll appears in the log for the GM only, with a Hidden tag. Retention is the same 30 days.
7. A GM can reveal a hidden roll. It becomes `visibility = 'team'`, a `roll.revealed` event goes to the team, and it appears in everyone's log at its original place in time. Replay does not happen. An optional "Also show on the table" makes it the shared table state.
8. A revealed roll cannot be hidden again. A public roll cannot become hidden.
9. Hidden Push the Limit and Second Chance run entirely hidden. The chain shares one visibility.

Admin permission: the admin sees hidden rolls only if also that team's GM, for that team.

## Protocol changes

- `roll.request.visibility` accepts `team` or `gm`. The object validates against the sender's team role from the verified attachment. A non-GM sending `gm` gets `error { code: "forbidden" }` and no roll is created. If a GM omits the field, the object treats it as `gm`.
- For a hidden roll the object skips the lock, still creates the server seed and stores a row, and sends `roll.begin`, `roll.wave` and `roll.complete` only to sockets whose attachment has the roller's `userId`.
- `roll.reveal { rollId, showOnTable }` from the GM. The object checks ownership and `visibility = 'gm'`, sets `revealed_at` and `visibility = 'team'`, then sends `roll.revealed { rollId, roll, showOnTable }` to all members. If `showOnTable`, it sets `latest_roll_id` and broadcasts a `state` update for the table.
- Spectator checks from 10 never apply to hidden rolls because nobody else receives them.

## Redaction (the privacy guarantee)

Everything that leaves a team Durable Object goes through two functions:

```
canSee(viewer, roll):
  roll.visibility == 'team'  -> viewer is a team member
  roll.visibility == 'gm'    -> viewer.userId == roll.userId and viewer is that team's GM
```

- `broadcast(event, audience)` is the only place that sends WebSocket frames for roll events, and it applies `redact`.
- `visibleRolls(viewer)` is the only place that reads the `rolls` table, and it applies `canSee`. There is no unfiltered read function. A lint rule or review checklist item forbids `select ... from rolls` outside that module.
- The Worker never reads a team's `rolls` directly. It always calls the object.
- Hidden rolls do not count in anything a player can see: log counts, "last roll" times, pagination cursors (cursors are the `seq` of the last returned entry, never `seq - 1`), presence, or alarm-driven side effects.
- The object does nothing observable to players when a hidden roll starts or ends. No lock, no message, no state change, no delay of a player's roll.
- Requests for a hidden roll id by anyone except its owner return 404, identical to a random id.
- Application logs never contain hidden roll contents or seeds.
- Someone with database or dashboard access to the Cloudflare account can read everything. This is a social trust boundary, not a technical one. State it in the privacy note.

## Client

For a team GM, the roll controls show a visibility switch next to Roll, Push the Limit and Second Chance: Hidden (selected, default) and Visible to team, with text and an icon, not color alone. It resets to Hidden after every roll, including after errors or aborts. Hidden rolls show a persistent banner "Only you can see this roll" and a Hidden tag. Log entries have a Reveal action opening an in-page confirmation with the optional "Also show on the table". Players see no control and no trace of hidden rolls. The `R` shortcut rolls with the selected visibility.

## Acceptance criteria

1. A GM rolls with default settings. Two player clients receive no WebSocket messages about it (captured by a recorder), and their log, tray and presence do not change.
2. The GM's log shows the roll with a Hidden tag. The players' log never contains it, including after reload and when paging.
3. A player sending `roll.request` with `visibility: "gm"` is refused with `forbidden`.
4. A player requesting a hidden roll id receives 404, identical to a random id.
5. While the GM has a hidden roll in progress, a player rolls normally and the GM sees it begin on their tray.
6. The visibility switch resets to Hidden after every GM roll.
7. Revealing adds the roll to every member's log at its original chronological position and sends `roll.revealed`. Players see no replay.
8. "Also show on the table" makes the revealed roll the table state for everyone, including members who connect later.
9. A revealed roll cannot be re-hidden (409).
10. When the user stops being the team GM, their future rolls are visible, they lose reveal rights, and their existing hidden rolls become invisible to everyone until retention removes them.
11. An admin who is not the team GM sees no hidden rolls in the UI or API.
12. Leak audit: an automated test enumerates every API route and WebSocket message type while a hidden roll exists and asserts that no response or frame for a non-GM viewer contains the roll's id, seed, dice, result or attribution.

## Test plan

Unit tests for `canSee` across viewer types (GM owner, other GM, player, admin member, admin non-member, non-member) and visibilities, an integration test with five WebSocket clients and the leak audit, a fuzz test of pagination cursors, and a manual test on two devices with a human GM and a human player.

## Open decisions (defaults assumed)

Whether players see a placeholder when the GM rolls hidden (default none). What happens to hidden rolls after the GM role is removed (default invisible). Whether the admin gets an audit-only read path (default no).
