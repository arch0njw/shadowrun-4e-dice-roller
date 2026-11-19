# 03 User Profiles

Status: draft. Depends on: 02. Blocks: 04, 05, 07.

## Goal

Store a profile for each user that other features read: display name, avatar, and preferences. Add a profile page. Behavior is the same as the AWS 03. Only the storage and the write budget change.

## In scope

- `profiles` table, extended `/api/me`, `PATCH /api/me`.
- Profile page.
- Applying preferences on sign-in.

## Out of scope

Skin selection UI (04), admin editing other users (05), per-team nicknames.

## Data model

```sql
create table profiles (
  user_id         text primary key references users(id) on delete cascade,
  skin_id         text not null default 'shadowrun-black',
  default_pool    integer not null default 9 check (default_pool between 1 and 30),
  default_edge    integer not null default 3 check (default_edge between 0 and 7),
  glitch_all_crit integer not null default 0 check (glitch_all_crit in (0,1)),
  reduce_motion   text not null default 'system' check (reduce_motion in ('system','on','off')),
  theme           text not null default 'system' check (theme in ('system','light','dark')),
  updated_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

- A missing row means defaults. `GET /api/me` uses a `left join` with defaults, and the first `PATCH` upserts. The manual SQL in 02 needs no profile insert.
- Profile data is part of the single session query, so loading `/api/me` is still one D1 read.

## API

`GET /api/me` returns the body shown in the AWS 03 (id, email, displayName, avatarUrl, roles, profile).

`PATCH /api/me` is a partial update of `displayName` and any `profile` field.
- `displayName`: trimmed, 2 to 32 characters, no control characters, not only whitespace.
- Numeric fields within the ranges above. Unknown fields are rejected with 400. `email`, `roles` and `status` cannot be changed here.
- Returns the full updated body.
- Validation uses the shared zod schema.

Write budget: client debounces text fields by 500 ms, and the Worker allows 30 profile writes per user per hour (counted in memory per Worker isolate on a best-effort basis, with the D1 `updated_at` check as a backstop). Profile writes are rare, so the D1 write limit is not a concern.

## Client behavior

Same as the AWS 03: profile page from the avatar menu, per-field immediate save with inline Saved or error state, applying defaults and theme and motion overrides on sign-in, initials fallback when the avatar fails to load. The in-memory solo log from 00 is unchanged. Persistent logs are story 08.

## Privacy

Email is visible to the admin and the user only. Other users see display name and avatar. Profile rows cascade-delete with the user.

## Acceptance criteria

1. A new user gets a usable `/api/me` with default profile values and no `profiles` row.
2. Setting default pool to 12 and reloading starts with the pool stepper at 12.
3. Invalid display names and out-of-range numbers are rejected with field-level errors and change nothing.
4. `PATCH /api/me` with `roles` or `email` returns 400.
5. Theme `dark` overrides a light OS setting and persists across devices.
6. `reduce_motion = on` makes rolls resolve instantly without an OS setting.
7. Two browsers signed in as the same user show the same profile after reload.

## Test plan

zod boundary tests, API tests for partial updates and unknown fields, manual check of theme and motion overrides on a phone and a desktop.
