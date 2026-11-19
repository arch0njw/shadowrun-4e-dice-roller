# 05 User Management

Status: draft. Depends on: 02, 03. Blocks: 06.

## Goal

Give the admin an interface and API to create users, assign roles, disable and re-enable users, transfer the admin role, and see an audit trail. Rules and screens are the same as the AWS 05. This story lists the rules in brief and spells out what changes on D1.

## In scope

Admin API and console, role assignment, session revocation, audit log.

## Out of scope

Teams (06), email invitations (no mail is sent, the admin tells people to sign in), self-service sign-up, bulk import.

## Permissions

Only `admin` can list, create, edit, disable, delete, transfer, revoke sessions, and read the audit log. The GM sees only name and avatar through the team directory in 06.

## API (all require `admin`)

- `GET /api/admin/users?query=&status=&role=&cursor=`: 50 per page, keyset pagination on `(created_at, id)`.
- `POST /api/admin/users`: `{ email, displayName, roles?: ["player"] }`. Creates an `invited` user. `admin` cannot be assigned here. 409 on duplicate email.
- `PATCH /api/admin/users/:id`: `{ email?, displayName?, roles? }`.
- `POST /api/admin/users/:id/disable`, `/enable`, `/revoke-sessions`, `/reset-link` (clears `auth_sub`, sets status `invited`).
- `POST /api/admin/transfer-admin`: `{ toUserId }`.
- `DELETE /api/admin/users/:id`: only when the user has no team membership and has never rolled. Otherwise 409 and disable instead. Anonymization is in 10.
- `GET /api/admin/audit?cursor=`.

## Rules

1. The admin cannot disable, delete, or demote themselves. They can transfer the role.
2. `roles` in PATCH is the full desired set of non-admin roles. `admin` in the set is rejected.
3. Changing `email` for a linked user does not unlink their account. "Reset link" re-links.
4. Disabling revokes all sessions and tells each of the user's team Durable Objects to close their sockets (code 4001).
5. Removing `gm` from a user who is a team GM is rejected with the list of teams (06 supplies the check).
6. Display names follow the 03 rules.

## Writing safely on D1

D1 has no interactive transactions, so each operation is one `batch()` of statements, and correctness relies on constraints, not read-then-write logic.

- Transfer admin, as one `batch()` (D1 runs a batch as a single transaction, so concurrent batches are serialized):
  1. `delete from user_roles where role_id = 1 and user_id = :from and exists (select 1 from users where id = :to and status = 'active');`
  2. `insert into user_roles (user_id, role_id, granted_by) select :to, 1, :from where exists (select 1 from users where id = :to and status = 'active') and not exists (select 1 from user_roles where role_id = 1);`
  3. `insert or ignore into user_roles (user_id, role_id) values (:from, 3);`
  4. The audit insert.
  The Worker then checks the result: if step 2 inserted no row, it returns 409. Step 1 only deletes when the target is active, and step 2 only inserts when no admin exists, so the batch can never leave zero admins unless the target is invalid (in which case nothing was deleted).
- Two concurrent transfers: the batches run one after the other. The second one finds that `:from` is no longer admin, so step 1 deletes nothing, and step 2 finds an admin already exists, so it inserts nothing. It returns 409. A test runs two parallel requests 100 times and asserts exactly one admin after each run.
- Role edits use `delete` plus `insert` in one batch for the non-admin roles.

## Audit log

```sql
create table admin_audit (
  id        integer primary key autoincrement,
  at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id  text references users(id) on delete set null,
  action    text not null,
  target_id text,
  detail    text not null default '{}'
);
create index admin_audit_at_idx on admin_audit (at desc);
```

Every admin write adds an audit row in the same batch. Entries older than 365 days are deleted opportunistically at the end of admin writes (a bounded `delete ... where id in (select id ... limit 100)`), so no scheduled job is needed. Manual SQL changes are not audited. Document this.

## Admin console

Same as the AWS 05: `/admin/users` hidden from non-admins and enforced by the server, table with avatar, name, email, status chip, role chips, last sign-in, actions menu, search and filters, Add user dialog, row actions (Edit, Disable or Enable, Revoke sessions, Reset link, Delete, Make admin with a consequence statement), audit tab, in-page confirmations only.

## Acceptance criteria

1. Admin creates a user, that person signs in with Google and lands as `player` and `active`.
2. A non-admin gets 403 on every `/api/admin/*` route and sees no admin menu.
3. Disabling a signed-in user logs them out on their next request, closes their open sockets, and blocks new sign-ins.
4. The admin cannot disable or delete themselves (control disabled and server 409).
5. Transfer admin leaves exactly one admin at all times, including two concurrent requests (one 409).
6. Assigning `admin` through PATCH or create is rejected.
7. Every admin write appears in the audit view with the right actor and target.
8. Duplicate email creation returns 409 with a clear message.
9. The manual SQL bootstrap from 02 still works and that admin sees the console.

## Test plan

API tests for every rule including the concurrent transfer case, an authorization matrix by role, and a Playwright test for create, disable and transfer.
