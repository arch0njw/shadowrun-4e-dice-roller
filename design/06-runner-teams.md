# 06 Runner Teams

Status: draft. Depends on: 05. Blocks: 07, 08, 09.

## Goal

Introduce the Runner Team: a named group of users who share dice rolls. This story delivers team data, membership rules, authorization helpers, and a team switcher. Rolls are still local. Sharing starts in 07.

## In scope

Teams, memberships, per-team role (`gm` or `player`), management API and UI, active team selection, solo mode preserved.

## Out of scope

Sharing rolls (07), logs (08), hidden rolls (09), team invite links.

## Concepts (unchanged from the AWS 06)

- A user can belong to many teams.
- Within a team a member has a team role: `gm` or `player`.
- Being a team GM requires the global `gm` role.
- One GM per team at most.
- The global `admin` can manage any team but is not a member, and does not see a team's hidden rolls, unless also that team's GM.

## Data model (D1)

```sql
create table teams (
  id          text primary key default (lower(hex(randomblob(16)))),
  name        text not null check (length(name) between 2 and 48),
  created_by  text references users(id) on delete set null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at text
);
create unique index teams_name_active_idx on teams (lower(name)) where archived_at is null;

create table team_members (
  team_id   text not null references teams(id) on delete cascade,
  user_id   text not null references users(id) on delete cascade,
  team_role text not null check (team_role in ('gm','player')),
  joined_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (team_id, user_id)
);
create unique index team_one_gm_idx on team_members (team_id) where team_role = 'gm';
create index team_members_user_idx on team_members (user_id);
```

Rules checked inside the same `batch()` as the write, using conditional inserts (as in 05):
- A `gm` team role requires the user to hold global `gm`: `insert ... select ... where exists (select 1 from user_roles where user_id = :u and role_id = 2)`.
- Removing global `gm` from a team GM is rejected (this implements the 05 stub). The Worker checks for rows in `team_members` with `team_role = 'gm'` before the role batch and the batch itself repeats the check in its `where` clause.

## Team Durable Object

- Each team has one `TeamRoom` Durable Object, addressed by `idFromName(teamId)`. It is created lazily on first connection (07). Creating a team in D1 does not create the object.
- The object never decides who is a member. The Worker checks membership in D1 and passes a verified identity to the object (07).
- Membership or role changes call `TeamRoom.kick(userId, code)` (4002 when removed from the team) and `TeamRoom.refreshMember(userId)` when a role changes.
- Archiving a team sets `archived_at` and calls `TeamRoom.archive()`, which rejects new rolls. History stays until retention removes it (08).

## Permissions

Same table as the AWS 06: admin creates and manages any team; a global GM can create a team (becoming its GM) and manages their own teams; players have a read-only member list.

## API

- `GET /api/teams`, `POST /api/teams`, `PATCH /api/teams/:id`, `GET /api/teams/:id/members`, `PUT /api/teams/:id/members/:userId`, `DELETE /api/teams/:id/members/:userId`, and `GET /api/users/directory?query=`, with the same shapes and rules as the AWS 06. The directory returns id, display name and avatar only, 20 results, for admin and global GM.

## Authorization helper

One module `authz.ts` answers membership questions in the Worker: `teamRoleOf(userId, teamId)`, `assertMember`, `assertTeamGm`. Stories 07 to 09 use it and never query `team_members` directly. The Durable Object enforces the same rules again on every message using the identity it received.

## Client

Header team switcher with "Solo practice" plus teams (active team in `localStorage`, validated against `/api/teams`), team page `/teams/:id` for GM and admin (members, add via directory picker, remove, change role, rename, archive), read-only member list for players, Teams tab in the admin console. Solo practice behaves exactly as in 00.

## Acceptance criteria

1. A GM creates a team, is its only GM, adds players, and they see the team in their switcher.
2. A player cannot create, rename or edit a team.
3. A second GM on a team returns 409 naming the current GM, even with two concurrent requests.
4. A user without global `gm` cannot be set as team GM.
5. Removing global `gm` from a team GM is rejected with the affected teams.
6. A user removed from a team loses it on the next load, and any open socket to that team is closed with 4002 (verified once 07 exists).
7. Admin sees all teams and is not shown as a member unless added.
8. Solo practice works with no teams.
9. Archived teams leave the switcher and appear for admin under a filter.
10. Directory search never returns email addresses to non-admins.

## Test plan

Authorization matrix tests for every endpoint by role and membership, a concurrency test for the single-GM index, and a UI test for create team, add member, switch team.
