# 02 Google Sign-In, Users, and Roles

Status: draft. Depends on: 01. Blocks: 03 to 10.

## Goal

Require sign-in to use the app. Only people who already have a user row can get in. Introduce the roles `admin`, `gm`, `player`, and a way for you to create the first admin by hand in the database. Same behavior as the AWS 02, implemented on a Worker and D1.

## First task: sign-in spike

Before building anything else, confirm that the chosen sign-in works on a free address.

1. Create the Google Cloud project, OAuth consent screen, and a Web OAuth client. Add the `workers.dev` origin (for example `https://shadowrun-dice.<account>.workers.dev`) and `http://localhost:8787` as Authorized JavaScript origins.
2. Render the Google button on a test page served by the `dev` Worker, sign in, and POST the credential to a Worker route that only echoes the decoded claims after verification.
3. Record whether Google accepts the origin and whether the consent screen can be published in production status without extra verification for the basic scopes (`openid`, `email`, `profile`).

Outcomes:
- Works: continue with this spec as written.
- Rejected or blocked by public suffix rules: swap the provider behind the interface below to Discord or GitHub OAuth (both free, both work on `workers.dev`), or buy a domain (about 12 USD per year, which breaks the "completely free" goal).

Provider interface, so the rest of the app does not care:

```ts
interface AuthProvider {
  id: 'google' | 'discord' | 'github';
  // Given the client's proof (ID token or OAuth code), return a verified identity.
  verify(input: unknown, env: Env): Promise<{ sub: string; email: string; emailVerified: boolean;
                                              name?: string; picture?: string }>;
}
```

The Google provider is the only implementation built in this spec. The interface and the `users.google_sub` column name are generalized to `auth_sub` plus `auth_provider` (see schema) so a swap does not need a data migration.

## In scope

- Google Identity Services button, ID token verification in the Worker.
- Invite-only access based on a pre-created user row.
- Sessions in an HttpOnly cookie, stored in D1.
- `users`, `roles`, `user_roles`, `sessions` tables.
- Role-checking helpers.
- Manual admin bootstrap by SQL and by script.
- Signed-out screen, signed-in app shell.

## Out of scope

Profile editing (03), admin UI (05), teams (06), WebSocket authentication details (07, rules stated here).

## Data model (SQLite dialect)

```sql
create table users (
  id            text primary key default (lower(hex(randomblob(16)))),
  email         text not null unique collate nocase,
  auth_provider text not null default 'google',
  auth_sub      text,
  display_name  text not null,
  avatar_url    text,
  status        text not null default 'invited'
                check (status in ('invited','active','disabled')),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at text
);
create unique index users_auth_idx on users (auth_provider, auth_sub) where auth_sub is not null;

create table roles (id integer primary key, name text not null unique);
insert into roles (id, name) values (1,'admin'), (2,'gm'), (3,'player');

create table user_roles (
  user_id    text not null references users(id) on delete cascade,
  role_id    integer not null references roles(id),
  granted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  granted_by text references users(id),
  primary key (user_id, role_id)
);
-- exactly one admin at any time
create unique index user_roles_single_admin on user_roles (role_id) where role_id = 1;

create table sessions (
  id           text primary key default (lower(hex(randomblob(16)))),
  user_id      text not null references users(id) on delete cascade,
  token_hash   blob not null unique,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   text not null,
  revoked_at   text,
  user_agent   text
);
create index sessions_user_idx on sessions (user_id);
```

Enable `pragma foreign_keys = on` per connection (D1 enforces foreign keys by default; verify). Rules are the same as the AWS 02: email is the invitation key and case-insensitive; `auth_sub` is the permanent identity once linked; statuses `invited`, `active`, `disabled`; one admin enforced by the partial unique index (SQLite supports partial indexes).

## Sign-in flow

Same as the AWS 02, with Worker-specific verification:

1. Client posts `{ credential }` to `POST /api/auth/google`.
2. The Worker loads Google's signing keys from `https://www.googleapis.com/oauth2/v3/certs`, cached in memory and in the Cache API using the response `max-age`.
3. Verify with the Web Crypto API: RS256 signature, `iss` is `accounts.google.com` or `https://accounts.google.com`, `aud` equals `GOOGLE_CLIENT_ID`, `exp` in the future, `email_verified` true. Keep this routine small, because the free plan has little CPU per request. If measured CPU is too high, move verification into a Durable Object with the same code.
4. Look up the user by `(auth_provider, auth_sub)`, else by email where `auth_sub` is null.
5. Outcomes: no user gives 403 `not_invited`; `disabled` gives 403 `disabled`; otherwise link `auth_sub`, set `active`, update `last_login_at`, copy the picture if empty, create a session, set the cookie, return `/api/me`.

## Sessions and cookies

- Cookie `__Host-session=<256-bit random, base64url>`; `HttpOnly; Secure; SameSite=Lax; Path=/`. Only the SHA-256 is stored.
- Lifetime 30 days sliding, 90 days absolute. To protect the D1 write budget, `last_seen_at` is updated at most once per hour per session.
- `POST /api/auth/logout` revokes the session and clears the cookie.
- `GET /api/me` returns `{ id, email, displayName, avatarUrl, roles, status }` or 401. One join query loads user, roles and session together.
- Disabling a user or removing a role takes effect on the next request. For open WebSockets, the Worker calls each of the user's team Durable Objects to close their sockets with code 4001 (06 provides the team list, 07 implements the close).

## CSRF and origin checks

Same as the AWS 02: state-changing endpoints require `Content-Type: application/json` and an `Origin` equal to the app origin; WebSocket upgrades require the cookie and an allowed `Origin`. No tokens in URLs.

## Role checks

Helpers `requireAuth()` and `requireRole(...)`. Roles are loaded with the session on each request (single D1 read, no extra caching needed at this scale). Permission matrix is the same as the AWS 02.

## Admin bootstrap (manual)

SQL, run in the D1 console in the Cloudflare dashboard or with `npx wrangler d1 execute shadowrun-dice-prod --remote --command "..."`:

```sql
insert into users (email, display_name) values ('you@example.com', 'Your Name');

insert into user_roles (user_id, role_id)
select u.id, r.id from users u, roles r
where u.email = 'you@example.com' and r.name = 'admin';
```

Because of the single-admin index, a second insert of the admin role fails. To replace the admin by hand, run `delete from user_roles where role_id = 1;` first.

Script: `npm run user:add -- --env prod --email you@example.com --name "Your Name" --role admin [--role gm]`. It runs the same statements through `wrangler d1 execute` in one batch and refuses to create a second admin unless `--replace-admin` is passed.

Recovery cases for the runbook: admin lost their Google account (update `email`, set `auth_sub = null`, set `status = 'invited'`); admin set to `disabled` by mistake (set status back to `active`).

## Client changes

Same as the AWS 02: signed-out screen with the Google button and "Access is by invitation.", signed-in shell with avatar, name and Sign out, a fetch wrapper that handles 401. The dice roller is shown only when signed in.

## Acceptance criteria

1. The sign-in spike has a recorded outcome and a decision on the provider.
2. Signed out, only the sign-in screen is shown.
3. An uninvited account is refused with the not-invited message and no cookie is set.
4. After the SQL bootstrap, sign-in succeeds, status becomes `active`, `auth_sub` is stored, and `/api/me` lists `admin`.
5. Giving a second user the admin role fails on the unique index.
6. A disabled user cannot sign in and an existing session returns 401.
7. Cookie attributes match the spec. The raw cookie value is not in D1.
8. Tampered, expired, wrong-audience and unverified-email tokens return 401.
9. A POST with a foreign `Origin` returns 403.
10. `npm run user:add` creates a gm and a player and refuses a second admin.
11. Measured Worker CPU for sign-in stays under the free-plan limit confirmed in 01.

## Test plan

- Worker integration tests with a stubbed verifier covering each outcome.
- Migration test on an empty D1 and on one with 0001 applied.
- One manual end-to-end check per environment with a real Google account.

## Risks

- Google may reject the `workers.dev` origin, which is why the spike comes first.
- Web Crypto RSA verification cost on the free CPU budget.
- D1 batch semantics: every multi-step write must be a single `batch()` call.
