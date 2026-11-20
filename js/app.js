(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var rnd = function (a, b) { return a + Math.random() * (b - a); };
var stage = $('stage'), canvas = $('c');
var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- state ---------- */
var S = { pool: 9, edge: 3, edgeLeft: 3, thr: 0, busy: false, last: null, count: 0, log: [], anyCrit: false };
var dice = [];          // all dice currently on the table
var wave = null;        // dice currently being thrown
var instantFlag = false;
var dirty = true;

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
var world = new CANNON.World();
world.gravity.set(0, -60, 0);
world.broadphase = new CANNON.NaiveBroadphase();
world.solver.iterations = 14;
world.allowSleep = true;
var matDie = new CANNON.Material('die'), matTable = new CANNON.Material('table');
world.addContactMaterial(new CANNON.ContactMaterial(matTable, matDie, { friction: 0.35, restitution: 0.3 }));
world.addContactMaterial(new CANNON.ContactMaterial(matDie, matDie, { friction: 0.3, restitution: 0.35 }));
var floorBody = new CANNON.Body({ mass: 0, material: matTable });
floorBody.addShape(new CANNON.Plane());
floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
world.addBody(floorBody);

/* ---------- arena ---------- */
var arena = { aw: 19, ad: 12, ratio: 0 };
var walls = [];
var arenaGroup = new THREE.Group(); scene.add(arenaGroup);
var floorMat = new THREE.MeshStandardMaterial({ color: 0x22323c, roughness: 0.95 });
var rimMat = new THREE.MeshStandardMaterial({ color: 0x35495a, roughness: 0.8 });

function addWall(hx, hy, hz, x, y, z) {
  var b = new CANNON.Body({ mass: 0, material: matTable });
  b.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
  b.position.set(x, y, z);
  world.addBody(b); walls.push(b);
}
function buildArena(ratio) {
  var area = 230;
  arena.ratio = ratio;
  arena.ad = Math.sqrt(area / ratio);
  arena.aw = arena.ad * ratio;
  var hw = arena.aw / 2, hd = arena.ad / 2;
  walls.forEach(function (b) { world.removeBody(b); }); walls.length = 0;
  addWall(0.5, 12, hd + 1, hw + 0.5, 6, 0);
  addWall(0.5, 12, hd + 1, -hw - 0.5, 6, 0);
  addWall(hw + 1, 12, 0.5, 0, 6, hd + 0.5);
  addWall(hw + 1, 12, 0.5, 0, 6, -hd - 0.5);
  addWall(hw + 1, 0.5, hd + 1, 0, 18, 0);
  arenaGroup.children.slice().forEach(function (m) { arenaGroup.remove(m); m.geometry.dispose(); });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(arena.aw, arena.ad), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; arenaGroup.add(floor);
  var t = 0.7, h = 0.6;
  [[arena.aw + 2 * t, h, t, 0, hd + t / 2], [arena.aw + 2 * t, h, t, 0, -hd - t / 2],
   [t, h, arena.ad, hw + t / 2, 0], [t, h, arena.ad, -hw - t / 2, 0]].forEach(function (r) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(r[0], r[1], r[2]), rimMat);
    m.position.set(r[3], h / 2, r[4]); arenaGroup.add(m);
  });
  var ext = Math.max(arena.aw, arena.ad) * 0.85;
  var sc = sun.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix();
  sun.position.set(-arena.aw * 0.3, 24, arena.ad * 0.35);
  // keep resting dice inside the new walls
  dice.forEach(function (d) {
    d.body.position.x = clamp(d.body.position.x, -hw + 0.7, hw - 0.7);
    d.body.position.z = clamp(d.body.position.z, -hd + 0.7, hd - 0.7);
    d.mesh.position.copy(d.body.position);
    if (d.ring) d.ring.position.set(d.body.position.x, d.ring.position.y, d.body.position.z);
  });
}
var fitV = new THREE.Vector3();
function placeCam(d) {
  camera.position.set(0, d, d * 0.32);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
}
function fitCamera() {
  var hw = arena.aw / 2 + 0.8, hd = arena.ad / 2 + 0.8, pts = [];
  [-1, 1].forEach(function (sx) { [-1, 1].forEach(function (sz) { [0, 0.7].forEach(function (y) { pts.push([sx * hw, y, sz * hd]); }); }); });
  function fits() {
    return pts.every(function (p) { fitV.set(p[0], p[1], p[2]).project(camera); return Math.abs(fitV.x) <= 0.97 && Math.abs(fitV.y) <= 0.97; });
  }
  var lo = 8, hi = 160;
  for (var i = 0; i < 26; i++) { var mid = (lo + hi) / 2; placeCam(mid); if (fits()) hi = mid; else lo = mid; }
  placeCam(hi);
}

/* ---------- dice assets ---------- */
var FACE_VALUES = [3, 4, 1, 6, 2, 5];                       // +x, -x, +y, -y, +z, -z (opposites sum to 7)
var LOCAL = [[1,0,0,3],[-1,0,0,4],[0,1,0,1],[0,-1,0,6],[0,0,1,2],[0,0,-1,5]];
var PIPS = {
  1: [[1,1]], 2: [[0,0],[2,2]], 3: [[0,0],[1,1],[2,2]], 4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]], 6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]]
};
function faceCanvas(v, body) {
  var s = 128, c = document.createElement('canvas'); c.width = c.height = s;
  var g = c.getContext('2d');
  g.fillStyle = body; g.fillRect(0, 0, s, s);
  var gr = g.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s * 0.78);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.14)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  g.fillStyle = v === 1 ? '#e0242a' : (v >= 5 ? '#2fd117' : '#f5a30f');
  g.font = 'bold 92px "Arial Narrow", Arial, Helvetica, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(v), s * (v === 6 ? 0.45 : 0.5), s * 0.54);
  if (v === 6) { g.beginPath(); g.arc(s * 0.78, s * 0.8, 6, 0, Math.PI * 2); g.fill(); }
  return c;
}
function makeMats(body) {
  return FACE_VALUES.map(function (v) {
    var t = new THREE.CanvasTexture(faceCanvas(v, body)); t.anisotropy = maxAniso;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, metalness: 0.0 });
  });
}
var matsPool = makeMats('#26282b'), matsEdge = makeMats('#1d2c45');
function makeDieGeo() {
  var g = new THREE.BoxGeometry(1, 1, 1, 6, 6, 6), p = g.attributes.position, n = g.attributes.normal;
  var r = 0.11, lim = 0.5 - r, v = new THREE.Vector3(), inner = new THREE.Vector3(), dir = new THREE.Vector3();
  for (var i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(clamp(v.x, -lim, lim), clamp(v.y, -lim, lim), clamp(v.z, -lim, lim));
    dir.subVectors(v, inner);
    if (dir.lengthSq() > 1e-8) {
      dir.normalize(); v.copy(inner).addScaledVector(dir, r);
      p.setXYZ(i, v.x, v.y, v.z); n.setXYZ(i, dir.x, dir.y, dir.z);
    }
  }
  return g;
}
var dieGeo = makeDieGeo();
var ringGeo = new THREE.RingGeometry(0.66, 0.8, 40);
var ringHit = new THREE.MeshBasicMaterial({ color: 0xf2a93b, side: THREE.DoubleSide });
var ringOne = new THREE.MeshBasicMaterial({ color: 0xff6b8d, side: THREE.DoubleSide });

/* ---------- dice lifecycle ---------- */
function spawnDice(srcs) {
  var alongX = arena.aw >= arena.ad;
  var alongHalf = (alongX ? arena.aw : arena.ad) / 2, crossDim = alongX ? arena.ad : arena.aw;
  var usable = Math.max(0, crossDim - 1.6);
  var cols = Math.max(1, Math.floor(usable / 1.45) + 1);
  var step = cols > 1 ? usable / (cols - 1) : 0;
  var out = [];
  srcs.forEach(function (src, i) {
    var col = i % cols, layer = Math.floor(i / cols);
    var cross = (col - (cols - 1) / 2) * step + rnd(-0.2, 0.2);
    var along = alongHalf - 1.3 - Math.random() * 0.5;
    var y = 1.4 + layer * 1.25 + Math.random() * 0.3;
    var body = new CANNON.Body({ mass: 1, material: matDie });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)));
    body.linearDamping = 0.12; body.angularDamping = 0.2;
    body.allowSleep = true; body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.4;
    body.position.set(alongX ? along : cross, y, alongX ? cross : along);
    body.quaternion.setFromEuler(rnd(0, 6.28), rnd(0, 6.28), rnd(0, 6.28), 'XYZ');
    var sp = rnd(14, 24), cv = rnd(-2.5, 2.5);
    body.velocity.set(alongX ? -sp : cv, rnd(1, 4), alongX ? cv : -sp);
    body.angularVelocity.set(rnd(-25, 25), rnd(-25, 25), rnd(-25, 25));
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
function removeDice(list) {
  var gone = new Set(list);
  list.forEach(function (d) {
    scene.remove(d.mesh); world.removeBody(d.body);
    if (d.ring) scene.remove(d.ring);
  });
  dice = dice.filter(function (d) { return !gone.has(d); });
  dirty = true;
}
function clearDice() { removeDice(dice.slice()); }
function syncAll() {
  for (var i = 0; i < dice.length; i++) {
    dice[i].mesh.position.copy(dice[i].body.position);
    dice[i].mesh.quaternion.copy(dice[i].body.quaternion);
  }
}
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
function nudge(d) {
  d.nudges++;
  var b = d.body; b.wakeUp();
  b.velocity.set(rnd(-1.5, 1.5), rnd(7, 10), rnd(-1.5, 1.5));
  b.angularVelocity.set(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8));
}
function freeze(d) {
  var b = d.body;
  b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
  b.mass = 0; b.type = CANNON.Body.STATIC; b.updateMassProperties(); b.aabbNeedsUpdate = true;
}
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
function startWave(list) {
  return new Promise(function (resolve) {
    wave = { list: list, resolve: resolve, still: 0, t: 0 };
    if (reduceMotion || instantFlag) {
      var guard = 0;
      while (wave && guard++ < 2000) stepWave(1 / 60);
      syncAll();
    }
  });
}
function stepWave(dt) {
  var w = wave; if (!w) return;
  world.step(1 / 60, dt, 3);
  w.t += dt;
  var hw = arena.aw / 2, hd = arena.ad / 2, moving = false;
  w.list.forEach(function (d) {
    var b = d.body;
    if (b.position.y < -1 || Math.abs(b.position.x) > hw + 1.5 || Math.abs(b.position.z) > hd + 1.5 || b.position.y > 20) {
      b.position.set(rnd(-2, 2), 3, rnd(-2, 2)); b.velocity.set(0, 0, 0);
    }
    if (b.sleepState !== CANNON.Body.SLEEPING && (b.velocity.norm() > 0.2 || b.angularVelocity.norm() > 0.4)) moving = true;
  });
  w.still = moving ? 0 : w.still + 1;
  if (w.still >= 20 || w.t > 8) {
    syncAll();
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
function canSecond() {
  return !!S.last && !S.last.second && S.last.mode !== 'push' && S.edgeLeft > 0 &&
         dice.some(function (d) { return d.value < 5; });
}
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
async function doRoll(mode, opts) {
  opts = opts || {};
  if (S.busy) return;
  if (mode !== 'normal' && S.edgeLeft <= 0) return;
  if (mode === 'second' && !canSecond()) return;
  S.busy = true; instantFlag = !!opts.instant;
  $('hitsNum').textContent = '…';
  refreshUI();
  var label;
  try {
    if (mode === 'second') {
      S.edgeLeft--;
      var misses = dice.filter(function (d) { return d.value < 5; });
      var srcs = misses.map(function (d) { return d.src; });
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
    S.log = S.log.slice(0, 40);
    renderLog();
  } finally {
    S.busy = false; instantFlag = false; refreshUI();
  }
}

/* ---------- controls ---------- */
function readField(id, min, max, fallback) {
  var v = parseInt($(id).value, 10);
  return isNaN(v) ? fallback : clamp(v, min, max);
}
function setEdge(newEdge) {
  var old = S.edge;
  S.edge = newEdge;
  S.edgeLeft = clamp(S.edgeLeft + (newEdge - old), 0, newEdge);
}
$('pool').addEventListener('input', function () { S.pool = readField('pool', 1, 30, S.pool); refreshUI(); });
$('edge').addEventListener('input', function () { setEdge(readField('edge', 0, 7, S.edge)); refreshUI(); });
$('thr').addEventListener('input', function () { S.thr = readField('thr', 0, 20, S.thr); });
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
stage.addEventListener('click', function () { doRoll('normal'); });
document.addEventListener('keydown', function (e) {
  var tag = (e.target && e.target.tagName) || '';
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && tag !== 'INPUT' && tag !== 'TEXTAREA') doRoll('normal');
});

/* ---------- theme, sizing, loop ---------- */
function token(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function applyTheme() {
  renderer.setClearColor(new THREE.Color(token('--tray-bg') || '#17222a'));
  floorMat.color.set(token('--felt') || '#22323c');
  rimMat.color.set(token('--rim') || '#35495a');
  dirty = true;
}
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

var lastT = performance.now();
function frame(now) {
  var dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (wave) { stepWave(dt); syncAll(); dirty = true; }
  if (dirty) { dirty = false; renderer.render(scene, camera); }
  requestAnimationFrame(frame);
}

applyTheme(); resize(); refreshUI(); renderLog();
requestAnimationFrame(frame);
doRoll('normal', { instant: true, sample: true });
})();
