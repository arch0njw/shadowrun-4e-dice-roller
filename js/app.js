// Shadowrun 4e dice roller.
//
// Everything lives in one IIFE so these helpers and the handful of module-level
// variables below (S, dice, wave, ...) don't leak onto `window`. The app has
// three layers that all talk to the same `dice` array:
//   1. Physics (Cannon.js): each die is a falling/rolling rigid body (`body`).
//   2. Rendering (Three.js): each die has a matching mesh that just copies the
//      physics body's position/rotation every frame (see `syncAll`).
//   3. Game rules (Shadowrun 4e): once a die's body stops moving, we read
//      which face is pointing up and feed that into hit/glitch counting.
// There's no "animation" authored anywhere - the tumbling you see is just the
// physics simulation running freely until it settles.
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var rnd = function (a, b) { return a + Math.random() * (b - a); };
var stage = $('stage'), canvas = $('c');
var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- state ---------- */
// S is the single source of truth for "what the player has configured and
// where things stand" - pool/edge/threshold inputs, Edge points remaining,
// whether a roll is in flight, and the last roll's outcome (needed to know
// whether Second Chance is currently legal).
var S = { pool: 9, edge: 3, edgeLeft: 3, thr: 0, busy: false, last: null, count: 0, log: [], anyCrit: false };
var dice = [];          // all dice currently on the table
var wave = null;        // dice currently being thrown
var instantFlag = false;
var dirty = true;       // true => re-render next frame (we skip rendering idle frames to save battery)

/* ---------- renderer ---------- */
var renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
} catch (e) {
  stage.innerHTML = '<p style="color:#cdd7de;padding:20px;font:14px sans-serif">WebGL is not available in this browser, so the dice tray cannot be shown.</p>';
  return;
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
var maxAniso = renderer.capabilities.getMaxAnisotropy();
var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(36, 1, 0.1, 300);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4650, 0.62));
var sun = new THREE.DirectionalLight(0xffffff, 0.55);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
scene.add(sun); scene.add(sun.target);

/* ---------- physics ---------- */
// One shared Cannon.js world for every die. Units are arbitrary "tray units",
// not meters - gravity and velocities below are tuned by eye against the
// arena size, not any real-world scale.
var world = new CANNON.World();
world.gravity.set(0, -60, 0);
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 14;
world.allowSleep = true;      // bodies that stop moving "sleep" (skip physics work) until nudged
var matDie = new CANNON.Material('die'), matTable = new CANNON.Material('table');
world.addContactMaterial(new CANNON.ContactMaterial(matTable, matDie, { friction: 0.35, restitution: 0.3 }));
world.addContactMaterial(new CANNON.ContactMaterial(matDie, matDie, { friction: 0.3, restitution: 0.35 }));
var floorBody = new CANNON.Body({ mass: 0, material: matTable }); // mass 0 = immovable
floorBody.addShape(new CANNON.Plane());
floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2); // Cannon planes default to facing +z; rotate to face up
world.addBody(floorBody);

/* ---------- arena ---------- */
// The "arena" is the rectangular tray floor plus four raised rim walls, sized
// to roughly match the tray's on-screen aspect ratio so it fills the viewport
// without the camera having to zoom out awkwardly. buildArena() is called
// whenever the stage is resized (see `resize` near the bottom).
var arena = { aw: 19, ad: 12, ratio: 0 }; // aw/ad = arena width/depth in tray units
var walls = [];
var arenaGroup = new THREE.Group(); scene.add(arenaGroup);
var floorMat = new THREE.MeshStandardMaterial({ color: 0x22323c, roughness: 0.95 });
var rimMat = new THREE.MeshStandardMaterial({ color: 0x35495a, roughness: 0.8 });

// Adds one static (immovable) box-shaped physics wall; `h*` are half-extents.
function addWall(hx, hy, hz, x, y, z) {
  var b = new CANNON.Body({ mass: 0, material: matTable });
  b.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
  b.position.set(x, y, z);
  world.addBody(b); walls.push(b);
}
// Rebuilds the floor, four rim walls, and a tall "ceiling" wall (keeps a hard
// Push the Limit throw from flying off the table) to fit the given
// width/depth aspect ratio, keeping total floor area roughly constant.
function buildArena(ratio) {
  var area = 230;
  arena.ratio = ratio;
  arena.ad = Math.sqrt(area / ratio);
  arena.aw = arena.ad * ratio;
  var hw = arena.aw / 2, hd = arena.ad / 2;
  walls.forEach(function (b) { world.removeBody(b); }); walls.length = 0;
  addWall(0.5, 12, hd + 1, hw + 0.5, 6, 0);       // right wall
  addWall(0.5, 12, hd + 1, -hw - 0.5, 6, 0);      // left wall
  addWall(hw + 1, 12, 0.5, 0, 6, hd + 0.5);       // far wall
  addWall(hw + 1, 12, 0.5, 0, 6, -hd - 0.5);      // near wall
  addWall(hw + 1, 0.5, hd + 1, 0, 18, 0);         // invisible ceiling, well above the dice
  arenaGroup.children.slice().forEach(function (m) { arenaGroup.remove(m); m.geometry.dispose(); });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(arena.aw, arena.ad), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; arenaGroup.add(floor);
  // Visible rim trim (purely cosmetic - the physics walls above are invisible
  // and slightly further out than this trim geometry).
  var t = 0.7, h = 0.6;
  [[arena.aw + 2 * t, h, t, 0, hd + t / 2], [arena.aw + 2 * t, h, t, 0, -hd - t / 2],
   [t, h, arena.ad, hw + t / 2, 0], [t, h, arena.ad, -hw - t / 2, 0]].forEach(function (r) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(r[0], r[1], r[2]), rimMat);
    m.position.set(r[3], h / 2, r[4]); arenaGroup.add(m);
  });
  // Re-fit the shadow camera's frustum to the new arena size so shadows stay sharp.
  var ext = Math.max(arena.aw, arena.ad) * 0.85;
  var sc = sun.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix();
  sun.position.set(-arena.aw * 0.3, 24, arena.ad * 0.35);
  // If the arena just shrank (e.g. window resized narrower), pull any resting
  // dice back inside the new walls instead of leaving them clipping through.
  dice.forEach(function (d) {
    d.body.position.x = clamp(d.body.position.x, -hw + 0.7, hw - 0.7);
    d.body.position.z = clamp(d.body.position.z, -hd + 0.7, hd - 0.7);
    d.mesh.position.copy(d.body.position);
    if (d.ring) d.ring.position.set(d.body.position.x, d.ring.position.y, d.body.position.z);
  });
}

// --- Camera auto-framing ---
// Rather than hand-tune a camera distance per arena size, we binary-search
// for the closest distance at which every arena corner still projects inside
// the visible frame. This keeps the tray filling the screen at any aspect
// ratio without per-breakpoint camera constants.
var fitV = new THREE.Vector3();
function placeCam(d) {
  camera.position.set(0, d, d * 0.32); // fixed downward-looking angle; only distance changes
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
}
function fitCamera() {
  var hw = arena.aw / 2 + 0.8, hd = arena.ad / 2 + 0.8, pts = [];
  [-1, 1].forEach(function (sx) { [-1, 1].forEach(function (sz) { [0, 0.7].forEach(function (y) { pts.push([sx * hw, y, sz * hd]); }); }); });
  // "Fits" = every test point's NDC (normalized device coords, -1..1) is within frame, with a small margin.
  function fits() {
    return pts.every(function (p) { fitV.set(p[0], p[1], p[2]).project(camera); return Math.abs(fitV.x) <= 0.97 && Math.abs(fitV.y) <= 0.97; });
  }
  var lo = 8, hi = 160;
  for (var i = 0; i < 26; i++) { var mid = (lo + hi) / 2; placeCam(mid); if (fits()) hi = mid; else lo = mid; }
  placeCam(hi);
}

/* ---------- dice assets ---------- */
// Three.js BoxGeometry assigns its 6 faces to materials in the fixed order
// +x, -x, +y, -y, +z, -z. FACE_VALUES maps that same order to the die pip
// value painted on each face, chosen so opposite faces always sum to 7 (a
// real d6's rule). LOCAL repeats that mapping as local-space direction
// vectors, used later by topFace() to find out which face ends up pointing
// up after a physics-driven roll.
var FACE_VALUES = [3, 4, 1, 6, 2, 5];                       // +x, -x, +y, -y, +z, -z (opposites sum to 7)
var LOCAL = [[1,0,0,3],[-1,0,0,4],[0,1,0,1],[0,-1,0,6],[0,0,1,2],[0,0,-1,5]];
var PIPS = {   // unused by the current numeral-style faces; kept for a possible pip-style skin
  1: [[1,1]], 2: [[0,0],[2,2]], 3: [[0,0],[1,1],[2,2]], 4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]], 6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]]
};
// Draws one die face (background + numeral) onto a small canvas, used as a
// texture. Doing this in canvas instead of loading image files keeps the
// whole dice look self-contained in code.
function faceCanvas(v, body) {
  var s = 128, c = document.createElement('canvas'); c.width = c.height = s;
  var g = c.getContext('2d');
  g.fillStyle = body; g.fillRect(0, 0, s, s);
  var gr = g.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s * 0.78);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.14)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s); // subtle vignette so faces aren't flat-looking
  g.fillStyle = v === 1 ? '#e0242a' : (v >= 5 ? '#2fd117' : '#f5a30f'); // 1 = red, 5/6 = green (hits), else amber
  g.font = 'bold 92px "Arial Narrow", Arial, Helvetica, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(v), s * (v === 6 ? 0.45 : 0.5), s * 0.54);
  if (v === 6) { g.beginPath(); g.arc(s * 0.78, s * 0.8, 6, 0, Math.PI * 2); g.fill(); } // extra dot so "6" can't be misread as "9" upside down
  return c;
}
// Builds the 6 face materials (in FACE_VALUES order) for one die "skin" body color.
function makeMats(body) {
  return FACE_VALUES.map(function (v) {
    var t = new THREE.CanvasTexture(faceCanvas(v, body)); t.anisotropy = maxAniso;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, metalness: 0.0 });
  });
}
var matsPool = makeMats('#26282b'), matsEdge = makeMats('#1d2c45'); // pool dice vs. Edge dice get different body colors
// Builds a cube geometry with rounded edges/corners (a plain BoxGeometry
// looks too sharp/plastic). Works by pushing each vertex inward to a
// "core" cube of half-size `lim`, then back out by the rounding radius `r`
// along its own normal - the standard "inflate a smaller box" trick for
// faking rounded corners without a dedicated rounded-box mesh generator.
function makeDieGeo() {
  var g = new THREE.BoxGeometry(1, 1, 1, 6, 6, 6), p = g.attributes.position, n = g.attributes.normal;
  var r = 0.11, lim = 0.5 - r, v = new THREE.Vector3(), inner = new THREE.Vector3(), dir = new THREE.Vector3();
  for (var i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(clamp(v.x, -lim, lim), clamp(v.y, -lim, lim), clamp(v.z, -lim, lim));
    dir.subVectors(v, inner);
    if (dir.lengthSq() > 1e-8) { // skip face-center vertices, which are already exactly on the core cube
      dir.normalize(); v.copy(inner).addScaledVector(dir, r);
      p.setXYZ(i, v.x, v.y, v.z); n.setXYZ(i, dir.x, dir.y, dir.z);
    }
  }
  return g;
}
var dieGeo = makeDieGeo();              // shared by every die mesh - geometry is identical, only material/position differ
var ringGeo = new THREE.RingGeometry(0.66, 0.8, 40); // flat annulus decal placed under a die to highlight hits/ones
var ringHit = new THREE.MeshBasicMaterial({ color: 0xf2a93b, side: THREE.DoubleSide });
var ringOne = new THREE.MeshBasicMaterial({ color: 0xff6b8d, side: THREE.DoubleSide });

/* ---------- dice lifecycle ---------- */
// Creates physics bodies + meshes for a batch of dice and throws them in from
// one edge of the arena. `srcs` is an array of 'pool' | 'edge' | 'explode'
// strings, one per die to spawn (this also determines body color and whether
// the die counts toward glitches - see computeResult). Dice are laid out in
// a grid of starting positions along the throw edge so a big pool doesn't
// spawn all dice stacked on one point.
function spawnDice(srcs) {
  var alongX = arena.aw >= arena.ad;                         // throw along the arena's longer axis
  var alongHalf = (alongX ? arena.aw : arena.ad) / 2, crossDim = alongX ? arena.ad : arena.aw;
  var usable = Math.max(0, crossDim - 1.6);
  var cols = Math.max(1, Math.floor(usable / 1.45) + 1);     // how many dice fit side-by-side across the throw
  var step = cols > 1 ? usable / (cols - 1) : 0;
  var out = [];
  srcs.forEach(function (src, i) {
    var col = i % cols, layer = Math.floor(i / cols);        // wrap extra dice into stacked "layers" above the first row
    var cross = (col - (cols - 1) / 2) * step + rnd(-0.2, 0.2);
    var along = alongHalf - 1.3 - Math.random() * 0.5;       // start near one edge of the arena
    var y = 1.4 + layer * 1.25 + Math.random() * 0.3;
    var body = new CANNON.Body({ mass: 1, material: matDie });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)));
    body.linearDamping = 0.12; body.angularDamping = 0.2;    // air resistance, so dice don't slide/spin forever
    body.allowSleep = true; body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.4;
    body.position.set(alongX ? along : cross, y, alongX ? cross : along);
    body.quaternion.setFromEuler(rnd(0, 6.28), rnd(0, 6.28), rnd(0, 6.28), 'XYZ'); // random starting orientation
    var sp = rnd(14, 24), cv = rnd(-2.5, 2.5);               // throw speed along the arena, small sideways drift
    body.velocity.set(alongX ? -sp : cv, rnd(1, 4), alongX ? cv : -sp);
    body.angularVelocity.set(rnd(-25, 25), rnd(-25, 25), rnd(-25, 25)); // tumble spin
    world.addBody(body);
    var mesh = new THREE.Mesh(dieGeo, src === 'pool' ? matsPool : matsEdge);
    mesh.castShadow = true;
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion);
    scene.add(mesh);
    var d = { body: body, mesh: mesh, src: src, value: 0, ring: null, nudges: 0 };
    dice.push(d); out.push(d);
  });
  dirty = true;
  return out;
}
// Removes dice from both the physics world and the scene, and from `dice`.
function removeDice(list) {
  var gone = new Set(list);
  list.forEach(function (d) {
    scene.remove(d.mesh); world.removeBody(d.body);
    if (d.ring) scene.remove(d.ring);
  });
  dice = dice.filter(function (d) { return !gone.has(d); });
  dirty = true;
}
function clearDice() { removeDice(dice.slice()); } // .slice() because removeDice mutates `dice` while iterating
// Copies every die's physics transform onto its mesh. Physics and rendering
// are kept deliberately separate (Cannon bodies vs. Three meshes); this is
// the only place they're synced.
function syncAll() {
  for (var i = 0; i < dice.length; i++) {
    dice[i].mesh.position.copy(dice[i].body.position);
    dice[i].mesh.quaternion.copy(dice[i].body.quaternion);
  }
}
// Figures out which face value is pointing "up" (highest world-space Y) once
// a die has stopped moving, by rotating each face's local direction vector
// (LOCAL) by the die's current orientation and keeping the one with the
// largest Y component. `up` is how close to straight up that face is
// (1.0 = dead level); used to detect a die resting on an edge/corner.
var tmpV = new THREE.Vector3();
function topFace(d) {
  var best = -2, val = 1;
  for (var i = 0; i < 6; i++) {
    var L = LOCAL[i];
    tmpV.set(L[0], L[1], L[2]).applyQuaternion(d.mesh.quaternion);
    if (tmpV.y > best) { best = tmpV.y; val = L[3]; }
  }
  return { val: val, up: best };
}
// Gives a "cocked" die (resting on an edge/corner instead of a face) a small
// random kick so physics gets another chance to settle it flat.
function nudge(d) {
  d.nudges++;
  var b = d.body; b.wakeUp();
  b.velocity.set(rnd(-1.5, 1.5), rnd(7, 10), rnd(-1.5, 1.5));
  b.angularVelocity.set(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8));
}
// Locks a settled die in place: zeroes its motion and converts it to a static
// (mass 0) body so it stops costing physics-solver time but still blocks
// later throws (dice already on the table act as obstacles).
function freeze(d) {
  var b = d.body;
  b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
  b.mass = 0; b.type = CANNON.Body.STATIC; b.updateMassProperties(); b.aabbNeedsUpdate = true;
}
// Adds a colored ring decal under hit (>=5) and one (1, non-exploded) dice,
// purely so results are readable on the tray at a glance.
function decorate(list) {
  list.forEach(function (d) {
    var mat = d.value >= 5 ? ringHit : (d.value === 1 && d.src !== 'explode' ? ringOne : null);
    if (!mat) return;
    var m = new THREE.Mesh(ringGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(d.body.position.x, Math.max(0.03, d.body.position.y - 0.47), d.body.position.z);
    scene.add(m); d.ring = m;
  });
  dirty = true;
}

/* ---------- throwing and settling ---------- */
// A "wave" is one batch of dice thrown together (the initial pool+edge roll,
// or one Push the Limit explosion wave, or a Second Chance reroll). startWave
// returns a promise that resolves once every die in the wave has come to
// rest and been read. Normally the promise resolves asynchronously as
// requestAnimationFrame drives stepWave(); but with reduced-motion or the
// instant-roll flag, we instead fast-forward the physics synchronously in a
// tight loop so the result appears immediately with no visible animation.
function startWave(list) {
  return new Promise(function (resolve) {
    wave = { list: list, resolve: resolve, still: 0, t: 0 };
    if (reduceMotion || instantFlag) {
      var guard = 0; // hard cap so a pathological physics state can't infinite-loop the tab
      while (wave && guard++ < 2000) stepWave(1 / 60);
      syncAll();
    }
  });
}
// Advances the current wave's physics by `dt` and checks whether it has
// settled. "Settled" means every die's linear/angular speed has stayed below
// a small threshold for 20 consecutive steps (`w.still >= 20`), or a hard
// 8-second timeout has elapsed so a rare physics glitch can't stall the game
// forever. Any die that falls through the floor or flies off the arena
// (shouldn't normally happen, but physics edge cases exist) gets silently
// teleported back above the table.
function stepWave(dt) {
  var w = wave; if (!w) return;
  world.step(1 / 60, dt, 3); // fixed internal timestep for stability; dt only affects how many sub-steps conceptually pass
  w.t += dt;
  var hw = arena.aw / 2, hd = arena.ad / 2, moving = false;
  w.list.forEach(function (d) {
    var b = d.body;
    if (b.position.y < -1 || Math.abs(b.position.x) > hw + 1.5 || Math.abs(b.position.z) > hd + 1.5 || b.position.y > 20) {
      b.position.set(rnd(-2, 2), 3, rnd(-2, 2)); b.velocity.set(0, 0, 0); // rescue: drop it back near the center
    }
    if (b.sleepState !== CANNON.Body.SLEEPING && (b.velocity.norm() > 0.2 || b.angularVelocity.norm() > 0.4)) moving = true;
  });
  w.still = moving ? 0 : w.still + 1;
  if (w.still >= 20 || w.t > 8) {
    syncAll();
    // Check for any die resting on an edge/corner rather than a face
    // ("cocked") and give it one more nudge, up to 4 tries per die, as long
    // as we haven't already hit the 8-second timeout.
    var cocked = [];
    w.list.forEach(function (d) {
      var f = topFace(d); d.value = f.val;
      if (f.up < 0.96 && d.nudges < 4 && w.t <= 8) cocked.push(d);
    });
    if (cocked.length) { cocked.forEach(nudge); w.still = 0; return; }
    wave = null; dirty = true;
    w.list.forEach(freeze);
    w.resolve();
  }
}

/* ---------- results ---------- */
// Shadowrun 4e scoring: a hit is any die showing 5 or 6. A glitch is more
// than half of the *original* pool+edge dice (not counting dice spawned by
// Push the Limit explosions) showing a 1. A glitch with zero hits is a
// critical glitch - or, with the "treat every glitch as critical" house
// rule enabled, any glitch at all counts as critical.
function computeResult() {
  var init = dice.filter(function (d) { return d.src !== 'explode'; });
  var ones = init.filter(function (d) { return d.value === 1; }).length;
  var hits = dice.filter(function (d) { return d.value >= 5; }).length;
  var glitch = ones * 2 > init.length;
  return { total: init.length, hits: hits, ones: ones, exploded: dice.length - init.length,
           glitch: glitch, crit: glitch && (hits === 0 || S.anyCrit), thr: S.thr };
}
function badge(text, k) {
  var s = document.createElement('span'); s.className = 'badge'; s.dataset.k = k; s.textContent = text; return s;
}
// Updates the result card: the big hit count, the dice/ones/exploded tallies,
// and the badge row (glitch state, plus a pass/fail-vs-threshold badge if a
// threshold was set).
function renderResult(r) {
  $('hitsNum').textContent = r ? r.hits : '0';
  $('fDice').textContent = r ? r.total : '0';
  $('fOnes').textContent = r ? r.ones : '0';
  $('fEx').textContent = r ? r.exploded : '0';
  var b = $('badges'); b.textContent = '';
  if (!r) return;
  b.appendChild(r.crit ? badge('Critical glitch', 'crit') : r.glitch ? badge('Glitch', 'glitch') : badge('No glitch', 'none'));
  if (r.thr > 0) {
    if (r.crit) b.appendChild(badge('Failed, threshold ' + r.thr, 'fail'));
    else if (r.hits >= r.thr) b.appendChild(badge('Success, ' + (r.hits - r.thr) + ' net, threshold ' + r.thr, 'ok'));
    else b.appendChild(badge('Failed by ' + (r.thr - r.hits) + ', threshold ' + r.thr, 'fail'));
  }
}
// Rebuilds the roll-history list from S.log (most recent roll first - see doRoll).
function renderLog() {
  var ol = $('log'); ol.textContent = '';
  S.log.forEach(function (e) {
    var li = document.createElement('li');
    var n = document.createElement('span'); n.className = 'n'; n.textContent = '#' + e.n;
    var l = document.createElement('span'); l.textContent = e.label;
    var h = document.createElement('span'); h.className = 'h'; h.textContent = e.hits + (e.hits === 1 ? ' hit' : ' hits');
    li.appendChild(n); li.appendChild(l); li.appendChild(h);
    if (e.crit || e.glitch) {
      var g = document.createElement('span'); g.className = 'g'; g.textContent = e.crit ? 'Critical glitch' : 'Glitch'; li.appendChild(g);
    }
    ol.appendChild(li);
  });
  $('logEmpty').hidden = S.log.length > 0;
}

/* ---------- roll flow ---------- */
// Second Chance is only legal right after a normal or Push the Limit roll
// (not after another Second Chance), with Edge left to spend, and only if
// the last roll actually has a die to reroll (something below a hit).
function canSecond() {
  return !!S.last && !S.last.second && S.last.mode !== 'push' && S.edgeLeft > 0 &&
         dice.some(function (d) { return d.value < 5; });
}
// Syncs every interactive control (buttons, steppers, Edge counter) to the
// current state - called after anything that might change what's legal.
function refreshUI() {
  var b = S.busy;
  $('roll').disabled = b;
  $('push').disabled = b || S.edgeLeft <= 0;
  $('second').disabled = b || !canSecond();
  ['pool', 'edge', 'thr', 'refresh'].forEach(function (id) { $(id).disabled = b; });
  document.querySelectorAll('.stepper button').forEach(function (x) { x.disabled = b; });
  $('rollSub').textContent = S.pool + (S.pool === 1 ? ' die' : ' dice');
  $('pushSub').textContent = '+' + S.edge + ' Edge ' + (S.edge === 1 ? 'die' : 'dice');
  $('edgeLeft').textContent = S.edgeLeft; $('edgeMax').textContent = S.edge;
  $('status').hidden = !b;
  stage.style.cursor = b ? 'progress' : 'pointer';
}
// Runs one full roll: 'normal' (just the pool), 'push' (pool + Edge dice,
// with sixes exploding into extra waves), or 'second' (reroll every current
// miss). Each case ends by computing and rendering the result and appending
// it to the roll log. `opts.instant` skips animation (used for the one-time
// sample roll on load); `opts.sample` just labels that roll in the log.
async function doRoll(mode, opts) {
  opts = opts || {};
  if (S.busy) return;                                  // ignore clicks while a roll is already resolving
  if (mode !== 'normal' && S.edgeLeft <= 0) return;     // Push/Second Chance both cost 1 Edge
  if (mode === 'second' && !canSecond()) return;
  S.busy = true; instantFlag = !!opts.instant;
  $('hitsNum').textContent = '…';
  refreshUI();
  var label;
  try {
    if (mode === 'second') {
      S.edgeLeft--;
      var misses = dice.filter(function (d) { return d.value < 5; });
      var srcs = misses.map(function (d) { return d.src; }); // keep each reroll die's original pool/edge color
      removeDice(misses);
      var nl = spawnDice(srcs);
      await startWave(nl); decorate(nl);
      S.last.second = true; label = 'Second Chance';
    } else {
      clearDice();
      var list = [];
      for (var i = 0; i < S.pool; i++) list.push('pool');
      if (mode === 'push') { S.edgeLeft--; for (var j = 0; j < S.edge; j++) list.push('edge'); }
      var first = spawnDice(list);
      await startWave(first); decorate(first);
      if (mode === 'push') {
        // Push the Limit: every 6 explodes into one more die, repeating until
        // a wave rolls no sixes (or we hit a safety cap on waves/total dice).
        var ex = first.filter(function (d) { return d.value === 6; }).length, guard = 0;
        while (ex > 0 && guard < 12 && dice.length < 160) {
          var more = spawnDice(new Array(ex).fill('explode'));
          await startWave(more); decorate(more);
          ex = more.filter(function (d) { return d.value === 6; }).length; guard++;
        }
      }
      S.last = { mode: mode, second: false };
      label = mode === 'push' ? S.pool + '+' + S.edge + 'd6 Push the Limit' : S.pool + 'd6';
    }
    var r = computeResult();
    renderResult(r);
    S.count++;
    S.log.unshift({ n: S.count, label: label + (opts.sample ? ' (sample)' : ''), hits: r.hits, glitch: r.glitch, crit: r.crit });
    S.log = S.log.slice(0, 40); // cap log length so it doesn't grow unbounded over a long session
    renderLog();
  } finally {
    S.busy = false; instantFlag = false; refreshUI();
  }
}

/* ---------- controls ---------- */
// Reads a numeric <input>, falling back to `fallback` on anything unparsable
// and clamping to [min, max]. Used so typing garbage into a field can't push
// invalid state into S.
function readField(id, min, max, fallback) {
  var v = parseInt($(id).value, 10);
  return isNaN(v) ? fallback : clamp(v, min, max);
}
// Changing the Edge rating shifts edgeLeft by the same delta, clamped to the
// new range - so raising Edge mid-session grants the difference, and
// lowering it can't leave edgeLeft above the new max.
function setEdge(newEdge) {
  var old = S.edge;
  S.edge = newEdge;
  S.edgeLeft = clamp(S.edgeLeft + (newEdge - old), 0, newEdge);
}
$('pool').addEventListener('input', function () { S.pool = readField('pool', 1, 30, S.pool); refreshUI(); });
$('edge').addEventListener('input', function () { setEdge(readField('edge', 0, 7, S.edge)); refreshUI(); });
$('thr').addEventListener('input', function () { S.thr = readField('thr', 0, 20, S.thr); });
// On blur/change, snap each field's displayed value back to the (possibly
// clamped) state value, in case the user left it showing something invalid.
['pool', 'edge', 'thr'].forEach(function (id) {
  $(id).addEventListener('change', function () { $(id).value = S[id]; });
});
document.querySelectorAll('.stepper button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var t = btn.dataset.t, inp = $(t), min = +inp.min, max = +inp.max;
    var next = clamp(S[t] + parseInt(btn.dataset.d, 10), min, max);
    if (t === 'edge') setEdge(next); else S[t] = next;
    inp.value = next; refreshUI();
  });
});
$('refresh').addEventListener('click', function () { S.edgeLeft = S.edge; refreshUI(); });
$('roll').addEventListener('click', function () { doRoll('normal'); });
$('push').addEventListener('click', function () { doRoll('push'); });
$('second').addEventListener('click', function () { doRoll('second'); });
$('anyCrit').addEventListener('change', function () { S.anyCrit = $('anyCrit').checked; });
$('clearLog').addEventListener('click', function () { S.log = []; renderLog(); });
stage.addEventListener('click', function () { doRoll('normal'); }); // tapping the tray itself also rolls
document.addEventListener('keydown', function (e) {
  var tag = (e.target && e.target.tagName) || '';
  // "R" rolls, but not while the user is typing into a text field.
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && tag !== 'INPUT' && tag !== 'TEXTAREA') doRoll('normal');
});

/* ---------- theme, sizing, loop ---------- */
// Reads a CSS custom property's current value (so the 3D scene's colors stay
// in sync with the page's light/dark theme, which is driven entirely by CSS).
function token(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function applyTheme() {
  renderer.setClearColor(new THREE.Color(token('--tray-bg') || '#17222a'));
  floorMat.color.set(token('--felt') || '#22323c');
  rimMat.color.set(token('--rim') || '#35495a');
  dirty = true;
}
// Keeps the renderer, camera, and arena shape matched to the stage element's
// actual on-screen size. Rebuilding the arena is skipped mid-roll (`S.busy`)
// and for small aspect-ratio changes, so a roll in progress never has its
// floor yanked out from under it.
function resize() {
  var w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  var ratio = clamp(w / h, 0.62, 1.8);
  if (!arena.ratio || (!S.busy && Math.abs(ratio / arena.ratio - 1) > 0.2)) buildArena(ratio);
  fitCamera(); dirty = true;
}
new ResizeObserver(resize).observe(stage);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Main render loop. Physics only advances while a wave is in flight; when
// nothing is animating and nothing is `dirty`, we skip re-rendering the frame
// entirely (idle tray costs ~0 GPU/CPU).
var lastT = performance.now();
function frame(now) {
  var dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; // clamp dt so a tab-switch pause can't fling physics
  if (wave) { stepWave(dt); syncAll(); dirty = true; }
  if (dirty) { dirty = false; renderer.render(scene, camera); }
  requestAnimationFrame(frame);
}

applyTheme(); resize(); refreshUI(); renderLog();
requestAnimationFrame(frame);
doRoll('normal', { instant: true, sample: true }); // show a result immediately on load, with no animation
})();
