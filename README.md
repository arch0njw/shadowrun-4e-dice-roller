# Shadowrun Dice Roller

A single-file, physics-based dice roller for Shadowrun, 4th Edition. Dice are
simulated in 3D (Three.js + Cannon.js) and tumble on a tray; the result is
whatever face lands up, not a random-number shortcut.

Open `Shadowrun-4e-Dice-Roller.html` directly in a browser — no build step, no
server, no dependencies to install. It pulls Three.js, Cannon.js, and two
Google fonts from public CDNs at load time; everything else is inline in the
one HTML file.

It's also hosted for free via GitHub Pages:
**https://arch0njw.github.io/shadowrun-4e-dice-roller/**

## Features

- **Dice pool, Edge, and Threshold** fields with steppers (`pool` 1–30,
  `edge` 0–7, `thr` 0–20).
- **Roll** the current pool on the tray; tapping the tray also rolls.
- **Push the Limit** — spends 1 Edge, adds your Edge rating in dice, and
  rerolls (explodes) every 6 so it keeps counting.
- **Second Chance** — spends 1 Edge and rerolls every die that isn't a hit;
  unavailable after Push the Limit.
- **Edge tracking** with a Refresh Edge button to reset Edge points for a
  new scene.
- **Roll log** of past rolls, with a Clear button.
- **Optional house rule**: treat every glitch as a critical glitch
  (checkbox).
- Light/dark theme follows the OS preference; respects
  `prefers-reduced-motion`.

### Rules implemented

- A hit is a 5 or a 6.
- A glitch is more than half the starting dice showing a 1; a glitch with
  no hits is a critical glitch.
- Exploded dice (from Push the Limit) don't count toward glitches.

## Status

This repo currently ships the dice roller as a standalone client with no
backend — open the HTML file and it works. The `design/` directory holds a
draft spec set for a future hosted, multiplayer version (Google sign-in,
Runner Teams, live shared rolls, GM-hidden rolls, etc.) built entirely on
free-tier Cloudflare and GitHub services; see
[`design/README.md`](design/README.md) for that roadmap. None of it is
implemented yet.

## License

MIT — see [LICENSE](LICENSE).
