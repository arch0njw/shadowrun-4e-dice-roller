# 04 Dice Skins

Status: draft. Depends on: 03. Used by: 07 (spectators render the roller's skin).

## Goal

Replace the hard-coded dice look with a data-driven skin system, ship five skins, and let each user pick one. This story is almost entirely client work and is the same as `../specs/04-skins.md`. Only the differences are listed here, followed by a compact restatement so this set stands alone.

## Differences from the AWS 04

- Skin list endpoint is served by the Worker: `GET /api/skins` returns `[{ id, name }]` generated from `/shared/skins` at build time.
- `skin_id` is stored in the D1 `profiles` table (03). `PATCH /api/me` validates it against the build-time list.
- Skin definitions and glyph assets are bundled with the client. No extra hosting.

## Skin definition (unchanged)

JSON files in `/shared/skins/` with `id`, `name`, `version`, `body` (color, roughness, metalness, opacity), `edgeBody` (color for Edge and exploded dice), and `face` (`style` numeral or pips, `glyphSet`, per-value `colors`, `sixDot`, `inset`).

A build script validates every skin against the zod schema and checks a 3:1 contrast ratio between each numeral color and its body color.

## Launch skins (unchanged)

| id | Name | Look |
| :--- | :--- | :--- |
| `shadowrun-black` | Shadowrun Black | Black body, 1 red, 2 to 4 amber, 5 and 6 green. Default. |
| `cobalt-gold` | Cobalt Gold | Translucent deep blue body, yellow numerals. |
| `smoke-white` | Smoke White | Black body, white numerals. |
| `slate-signal` | Slate Signal | Dark grey-green body, 1 red-orange, 2 to 4 black engraved with a light inset outline, 5 and 6 sky blue. |
| `classic-pips` | Classic Pips | Ivory body with pips, orange on 5 and 6, red large pip on 1. |

## Glyph set `sr-square`

Six SVG-path glyphs on a 100 by 100 grid matching the squared numerals on the physical dice, drawn to a 256 px canvas. Needs design review against the photo before the skin ships. `system-bold` stays as a fallback.

## Rendering

- `buildSkinMaterials(skin, variant)` returns six materials for `pool` or `edge`, cached by `skinId + variant + version`.
- Face-to-value order is unchanged from 00.
- Switching skins disposes old textures, re-skins dice on the table in place, and does not change any value.

## UI

Profile page section "Dice": radio-group grid of skin cards with a small preview of a 1, 4 and 6, and a "Roll preview" button that throws six dice locally without touching the log. Selection saves immediately.

## Acceptance criteria

1. `shadowrun-black` matches the current draft apart from the new glyph set.
2. All five skins render with readable numerals at phone width.
3. Changing skins updates dice on the table without re-rolling or changing results.
4. Reloading restores the skin from the profile on any device.
5. Edge and exploded dice are distinguishable from pool dice in every skin.
6. The build fails on an invalid skin or a contrast failure.
7. The API rejects an unknown `skinId`.
8. Twenty consecutive skin switches do not grow `renderer.info.memory.textures`.

## Test plan

Schema and contrast unit tests, a Playwright script that screenshots each skin for manual review, and a dispose test using `renderer.info`.

## Open items

Whether a viewer can force "show everyone in my skin" (decide in 07). The glyph paths need review.
