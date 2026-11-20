# 00 Current State

Status: baseline. This replaces the dangling reference to `../specs/00-current-state.md`
(a file from an earlier AWS-based design set that was never brought into this repo).
Stories 01-10 start from the app as described here, not from the AWS set.

This file describes the solo, client-only app as shipped on `main` as of PR #7
(`v1.0.7`). It exists so later stories have a real, in-repo baseline to diff
against instead of an assumption that nothing changed.

## What exists today

A single-page app (`Shadowrun-4e-Dice-Roller.html`, `css/styles.css`,
`js/app.js`) with no build step, no backend, and no persistence beyond the
current browser tab. Three.js + Cannon.js render a physics dice tray; game
rules are applied once dice settle. Hosted as a static page (GitHub Pages).

## Roll rules

- A **hit** is a die showing 5 or 6.
- A **glitch** (die value) is a 1.
- A roll **glitches** when the count of 1s among the *original* dice (the
  pool, plus Edge dice if Push the Limit was used - not counting dice spawned
  by exploding 6s) is **at least half of that original dice count, rounded
  down**. E.g. a 9-dice pool glitches at 4 or more ones (`floor(9/2) = 4`),
  not 5.
- A **critical glitch** is a glitch with zero hits.
- **Push the Limit**: spends 1 Edge, adds the Edge rating in extra dice to
  the pool, and every 6 (on any die, including dice from a previous
  explosion) is rerolled as an additional die that can itself explode again.
  Exploded dice count toward hits but never toward the glitch calculation.
- **"Sixes explode on every roll"** (independent toggle, not tied to Push the
  Limit): applies the same explosion-on-6 behavior described above to normal
  rolls too. Shares the same explosion loop as Push the Limit.
- **Second Chance**: spends 1 Edge, rerolls every die that is not a hit.
  Only legal immediately after a normal or Push the Limit roll (not after
  another Second Chance), and not available at all after a Push the Limit
  roll on the same throw.
- **Threshold**: optional. If set (>0), the result also shows pass/fail
  against the given number of hits.

### Testing-only critical-glitch modes

The "Treat every glitch as critical" checkbox, plus a skull-and-crossbones
button next to it, cycles through three interpretations used to exercise the
UI during testing. These are developer/QA affordances, not game rules, and
should not be migrated as player-facing behavior unless a later story
explicitly asks for that:

1. **Treat every glitch as critical** - any glitch is critical even with hits
   (this is the checkbox's original, default-on-check behavior).
2. **Treat every 1 as a glitch** - a single 1 anywhere forces glitch status;
   criticality still requires zero hits.
3. **Treat every 1 as critical** - a single 1 anywhere forces both glitch and
   critical glitch, regardless of hits.

## Dice skins

Two skins exist today, selectable from a dropdown, both client-only
(hardcoded body colors and a numeral-color function per skin, no JSON files,
no server, no per-user persistence):

| key | name | pool body | edge body | 1 | 2-4 | 5-6 |
| :-- | :--- | :-- | :-- | :-- | :-- | :-- |
| `chummer` (default) | Chummer | `#26282b` (near-black) | `#1d2c45` | `#e0242a` red | `#f5a30f` amber | `#2fd117` green |
| `adept` | Adept | `#6d7568` (sage-gray) | `#454d42` | `#e0642a` red-orange | `#1c1c1c` black | `#4fa3e8` blue |

Both skins use the same coding convention (red 1s, bright 5/6 hits, a muted
color for 2-4), just with different palettes. Switching skins disposes old
canvas textures and re-skins dice already on the table without re-rolling.

**This is a near-exact match for two of the five skins planned in
[04](04-skins.md):** `chummer` is `shadowrun-black`'s color scheme, and
`adept` is `slate-signal`'s. Story 04 should treat these two as already
designed and client-proven, and focus its new work on making skins
data-driven (JSON + `/api/skins` + persistence) and adding the remaining
three launch skins, rather than designing `shadowrun-black`/`slate-signal`
from scratch.

## UI/visual details worth knowing before a refactor

- A dedicated overlay flashes "Critical Glitch" over the tray on a critical
  glitch (CSS animation, auto-dismisses, restarts cleanly on back-to-back
  crits).
- The hits number and a badge row indicate glitch/critical-glitch/no-glitch/
  pass-fail state.
- The roll log shows a parenthetical `(expl: Xd6)` after the dice-count label
  whenever explosions increased the actual dice rolled past the initial pool
  (+Edge) count.
- Before each explosion wave, already-settled dice animate ("rack") into a
  sorted (low-to-high, top-to-bottom), left-side queue so incoming explosion
  dice have clear room to roll; new waves append to the queue rather than
  re-sorting dice already racked.
- The tray has a circuit-board-textured floor and a neon accent trim strip,
  themed via CSS custom properties kept in sync with the Three.js scene.
- A version footer (`v1.0.N`) tracks the highest PR number ever merged to
  `main`, monotonically. Manual, no CI enforcement yet - see the "version
  footer scheme" convention note if touching this during story 01's CI setup.

## What is *not* yet true

No sign-in, no stored profiles, no teams, no shared/live rolls, no roll log
persistence beyond the current tab, no GM/hidden rolls, no roles. All of
that is what stories 02-10 add.
