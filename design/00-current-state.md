# 00 Current State

Status: baseline pointer. This replaces the dangling reference to
`../specs/00-current-state.md` (a file from an earlier AWS-based design set
that was never brought into this repo).

This file does **not** restate the app's rules or UI — `js/app.js`'s own
comments are the authoritative, always-current description of roll rules,
glitch/critical-glitch logic, skins, and UI behavior. A second prose copy
here would just drift out of sync the way this file itself already did once
(see git history). Read `js/app.js` directly for current behavior before
starting any behavior-preserving refactor (Story 01, step 2).

## The one finding worth keeping on record

Two of the five launch skins planned in [04](04-skins.md) already exist,
client-side, as a hardcoded `chummer`/`adept` dropdown (see `SKINS` in
`js/app.js`): `chummer` matches `shadowrun-black`'s palette and `adept`
matches `slate-signal`'s. Story 04 should treat these two as already
designed and client-proven, and focus its new work on making skins
data-driven (JSON + `/api/skins` + persistence) and adding the remaining
three launch skins, rather than re-deriving `shadowrun-black`/`slate-signal`
from scratch.
