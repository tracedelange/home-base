(() => {
// Skip CSS transitions for the next two frames: on load, so nothing animates in from its no-JS state, and on back/forward
const freeze = () => {
  document.body.classList.add('boot');
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('boot')));
};
document.body.classList.add('chart');
freeze();

// Angular speed = K / r^1.5 (Kepler's third law), so outer bodies drift slower
const K_PLANET = 0.25;
const K_MOON = 0.15;
const GAP = 0.4;  // clearance between neighbouring planets' outermost moons, in chart units
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const snap = new URLSearchParams(location.search).has('snap'); // testing: skip camera easing

// ---------- SVG helpers ----------
const SVG = 'http://www.w3.org/2000/svg';
function el(parent, tag, attrs = {}) {
  const e = parent.appendChild(document.createElementNS(SVG, tag));
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

// ---------- starfield, after orca: two tiled layers that pan at a fraction of the camera's speed ----------
const TILE = 512;
const stars = document.body.insertBefore(document.createElementNS(SVG, 'svg'), document.body.firstChild);
stars.setAttribute('class', 'stars');
stars.setAttribute('aria-hidden', 'true');
const starLayers = [
  { name: 'far', speed: 0.08, count: 40, size: [0.5, 1] },
  { name: 'near', speed: 0.2, count: 12, size: [0.9, 1.6] },
].map(l => ({
  ...l,
  g: el(stars, 'g', { class: l.name }),
  tile: Array.from({ length: l.count }, () => [Math.random() * TILE, Math.random() * TILE, l.size[0] + Math.random() * (l.size[1] - l.size[0])]),
}));
function drawStars() {
  for (const l of starLayers) {
    l.g.replaceChildren();
    for (let i = 0; i < Math.ceil(innerWidth / TILE) + 1; i++)
      for (let j = 0; j < Math.ceil(innerHeight / TILE) + 1; j++)
        for (const [x, y, r] of l.tile) {
          const c = el(l.g, 'circle', { cx: x + i * TILE, cy: y + j * TILE, r });
          // About a third twinkle, each on its own clock
          if (Math.random() < 0.3) {
            c.classList.add('tw');
            c.style.animationDuration = `${3 + Math.random() * 5}s`;
            c.style.animationDelay = `${-Math.random() * 8}s`;
          }
        }
  }
}
drawStars();
addEventListener('resize', drawStars);

// ---------- chart, built from the nav markup and drawn on a 2D canvas each frame ----------
// (A canvas, not SVG: moving SVG made the browser re-rasterise the whole chart every frame, which phones can't keep up with)
const chart = document.getElementById('chart');
const ctx = chart.getContext('2d');

const planets = [...document.querySelectorAll('#system > li')].map((li, i) => {
  const p = {
    id: li.dataset.id, li, label: li.querySelector('.planet'),
    order: +li.dataset.order, size: +li.dataset.size, phase: i * 2.4, pos: [0, 0], screen: [0, 0, 0], w: 0,
  };
  li.querySelector('.moons').dataset.title = p.label.textContent;
  p.moons = [...li.querySelectorAll('.moons a')].map((a, j) => {
    const m = { label: a, r: p.size + 0.7 + j * 0.34, size: 0.11 + 0.05 * (j % 3), phase: j * 2.1, pos: [0, 0], screen: [0, 0, 0] };
    for (const [ev, on] of [['pointerenter', 1], ['pointerleave', 0], ['focus', 1], ['blur', 0]])
      a.addEventListener(ev, () => setHover(on ? m : null));
    return m;
  });
  return p;
});

// Orbits from the sun outwards: each planet sits one moon-system radius past the last one's, so planets with more
// moons get more room and no two systems overlap at any point in their rotation
let edge = 2.2;  // clear of the sun's halo
for (const p of [...planets].sort((a, b) => a.order - b.order)) {
  const reach = Math.max(p.size, ...p.moons.map(m => m.r + m.size));
  p.r = edge + reach;
  edge = p.r + reach + GAP;
}
const REACH = edge - GAP;    // outer edge of the outermost moon system
const BELT = edge + 1.8;     // centre of the stippled belt
const BEZEL = BELT + 2.7;    // edge of the chart, which the overview fits to the screen

// ---------- belt: stippled ink dots, orbiting on the GPU ----------
const canvas = document.querySelector('canvas:not(#chart)');
const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
let belt = null;
if (gl) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, '#version 300 es\nprecision highp float;\n' + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, `
layout(location=0) in vec4 a;  // orbit radius, phase, alpha, size (px)
uniform vec2 u_center, u_anchor, u_res; uniform float u_scale, u_zoom, u_t, u_k, u_dpr;
out float v_a;
void main() {
  float ang = a.y + u_t * u_k * pow(a.x, -1.5);
  vec2 s = (vec2(cos(ang), sin(ang)) * a.x - u_center) * u_scale + u_anchor;
  gl_Position = vec4(s.x / u_res.x * 2. - 1., 1. - s.y / u_res.y * 2., 0., 1.);
  gl_PointSize = a.w * u_dpr * min(1.6, sqrt(u_zoom));
  v_a = a.z;
}`));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `
in float v_a; uniform vec3 u_ink; out vec4 o;
void main() {
  float al = v_a * (1. - smoothstep(.5, 1., length(gl_PointCoord - .5) * 2.));
  o = vec4(u_ink * al, al);
}`));
  gl.linkProgram(prog);
  const u = {};
  for (const n of ['u_center', 'u_anchor', 'u_res', 'u_scale', 'u_zoom', 'u_t', 'u_k', 'u_dpr', 'u_ink']) u[n] = gl.getUniformLocation(prog, n);

  const rand = (a, b) => a + Math.random() * (b - a);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const n = 30000, data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = Math.random() < .8 ? BELT + gauss() * 1.6 : rand(BELT - 1.8, BEZEL - 1.2);  // belt, then sparse scatter (clear of Projects' moons)
    data.set([r, rand(0, 6.283), rand(.12, .5), rand(1, 1.8)], i * 4);
  }
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.useProgram(prog);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  belt = { u, n };
}
// Chart and belt colours follow the theme tokens
let ink = [0, 0, 0], col = {};
const readInk = () => {
  const css = getComputedStyle(document.documentElement);
  for (const k of ['paper-2', 'ink', 'ink-2', 'ink-3', 'accent', 'shade', 'disc', 'night-max']) col[k] = css.getPropertyValue('--' + k).trim();
  ink = [1, 3, 5].map(i => parseInt(col.ink.slice(i, i + 2), 16) / 255);
  // Night side: clear on the sun side, fading to the shade colour on the far limb
  const a = Math.round(+col['night-max'] * 255).toString(16).padStart(2, '0');
  col.night = [[0.3, col.shade + '00'], [0.85, col.shade + a], [1, col.shade + a]];
};
readInk();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readInk);

// Theme button cycles auto → light → dark. Auto follows the system; the others set data-theme, as in orca.
const themes = ['auto', 'light', 'dark'];
const themeBtn = document.querySelector('.theme');
themeBtn.textContent = document.documentElement.dataset.theme || 'auto';
themeBtn.addEventListener('click', () => {
  const next = themes[(themes.indexOf(themeBtn.textContent) + 1) % themes.length];
  const apply = () => {
    if (next === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch {}
    themeBtn.textContent = next;
    readInk();
  };
  if (!document.startViewTransition || reduceMotion) return apply();
  // The new palette spreads out from the button in a widening circle
  const { left, top, width, height } = themeBtn.getBoundingClientRect();
  const x = left + width / 2, y = top + height / 2, r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(apply).ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 900, easing: 'cubic-bezier(.6, 0, .3, 1)', pseudoElement: '::view-transition-new(root)' }));
});

// ---------- camera: world point `center` is drawn at screen point `anchor`, `scale` px per unit ----------
const cam = { center: [0, 0], anchor: [innerWidth / 2, innerHeight / 2], logScale: Math.log(4) };
let focus = null, shown = null, landed = null, hovered = null, focusAmt = 0, t = 0, timeScale = 1, last = performance.now(), jump = false;
let W = 0, H = 0, dpr = 1, scale = 1, overviewScale = 1;
// Phones stack the moon list under the planet; listTop is the list's top edge, so the planet can sit above it
const phone = matchMedia('(max-width: 640px)');
let listTop = 0;
const measureList = () => { listTop = focus ? focus.li.querySelector('.moons').getBoundingClientRect().top : 0; };
addEventListener('resize', measureList);
// Label widths, for keeping planet labels on screen; fonts arriving late change them
document.fonts.ready.then(() => { for (const p of planets) p.w = 0; measureList(); });

const toScreen = p => [(p[0] - cam.center[0]) * scale + cam.anchor[0], (p[1] - cam.center[1]) * scale + cam.anchor[1]];

// Routes: #planet focuses a planet; #planet/item lands on the moon whose link has that data-route
const back = document.querySelector('.back');
const surfaces = [...document.querySelectorAll('.surface')];
function setFocus(route) {
  const p = planets.find(p => p.id === route.split('/')[0]) || null;
  if (route && !p) return; // placeholder hashes like #todo are not planets
  focus = p;
  if (p) shown = p;
  landed = p?.moons.find(m => m.label.dataset.route === route) || null;
  document.body.classList.toggle('focusing', !!p);
  document.body.classList.toggle('landed', !!landed);
  document.body.classList.remove('rest');
  for (const q of planets) {
    q.li.classList.toggle('focused', q === p);
  }
  for (const s of surfaces) {
    const on = !!landed && s.dataset.route === route;
    if (on && !s.classList.contains('on')) s.scrollTop = 0;
    s.classList.toggle('on', on);
  }
  back.textContent = `← ${landed ? p.label.textContent : 'Back'}`;
  back.href = landed ? `#${p.id}` : '#';
  measureList();
}
// Once an article has faded in it covers the chart, so the chart stops drawing until you leave
for (const s of surfaces) s.addEventListener('transitionend', e => {
  if (e.target === s && e.propertyName === 'opacity' && s.classList.contains('on')) document.body.classList.add('rest');
});
// Back/forward (e.g. the iOS swipe) already has the browser's own slide, so go straight there instead of animating again.
// Also used on load, so a shared link opens where it points.
function jumpTo(route) {
  freeze();
  jump = true;
  setFocus(route);
  if (landed) document.body.classList.add('rest');  // no fade, so no transitionend to set it
}
// A hash change soon after a click or key press is the visitor moving around the chart; any other is back/forward
let acted = 0;
for (const ev of ['click', 'keydown']) addEventListener(ev, () => acted = performance.now(), true);
addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  performance.now() - acted < 500 ? setFocus(route) : jumpTo(route);
});
addEventListener('keydown', e => { if (e.key === 'Escape' && focus) location.hash = landed ? focus.id : ''; });
// Moon links point at static pages for no-JS visitors; here they land on the moon instead
for (const a of document.querySelectorAll('a[data-route]'))
  a.addEventListener('click', e => { e.preventDefault(); location.hash = a.dataset.route; });
jumpTo(location.hash.slice(1));

// Nearest body under the pointer: the focused planet's moons first, then planets
function pick(x, y) {
  let best = null, bestD = Infinity;
  for (const b of [...(focus ? focus.moons : []), ...planets]) {
    const d = Math.hypot(b.screen[0] - x, b.screen[1] - y);
    if (d < b.screen[2] + 12 && d < bestD) { best = b; bestD = d; }
  }
  return best;
}
// Hover links a body on the chart with its label, in both directions
function setHover(b) {
  if (b === hovered) return;
  hovered?.label.classList.remove('hot');
  b?.label.classList.add('hot');
  hovered = b;
  chart.classList.toggle('pointing', !!b);
}
chart.addEventListener('pointermove', e => setHover(pick(e.clientX, e.clientY)));
chart.addEventListener('click', e => {
  const b = pick(e.clientX, e.clientY);
  if (b?.id) location.hash = b.id;
  else if (b) b.label.click();  // a moon: follow its link
  else if (focus) location.hash = '';
  else launch(e.clientX, e.clientY);
});

// ---------- asteroids: click empty space to throw one; the sun's gravity bends its path ----------
const GM = 100;   // far stronger than the planets feel, so a rock crosses the chart in seconds
const TRAIL = 120; // positions kept for the tail
const rocks = [];
function launch(x, y) {
  const p = [(x - cam.anchor[0]) / scale + cam.center[0], (y - cam.anchor[1]) / scale + cam.center[1]];
  const r = Math.hypot(...p);
  if (r < 2) return;
  // Between a falling and an escaping orbit, moving the same way as the planets
  const v = Math.sqrt(GM / r) * (0.5 + Math.random() * 0.9);
  if (rocks.length >= 12) rocks.shift();
  rocks.push({ p, v: [-p[1] / r * v, p[0] / r * v], trail: [] });
}
function stepRocks(dt) {
  for (let i = rocks.length; i--;) {
    const k = rocks[i];
    // Substeps keep close passes by the sun stable
    for (let n = 0; n < 4; n++) {
      const h = dt / 4, a = -GM / Math.hypot(...k.p) ** 3 * h;
      k.v[0] += k.p[0] * a; k.v[1] += k.p[1] * a;
      k.p[0] += k.v[0] * h; k.p[1] += k.v[1] * h;
    }
    const r = Math.hypot(...k.p);
    // Gone once it falls into the sun or flies well past the belt
    if (r < 1.1 || r > BEZEL * 2) { rocks.splice(i, 1); continue; }
    k.trail.push([...k.p]);
    if (k.trail.length > TRAIL) k.trail.shift();
  }
}

// ---------- frame ----------
function resize() {
  dpr = Math.min(devicePixelRatio, 2);
  W = innerWidth; H = innerHeight;
  for (const c of [canvas, chart]) if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  }
  // Portrait screens fit the planets' moon systems to the width and let the belt run off the sides
  overviewScale = W < H ? W / 2 / (REACH + 0.6) : Math.min(W, H) / 2 * 0.94 / BEZEL;
}

function updateCamera(ease) {
  let goal = [0, 0], anchor = [W / 2, H / 2], goalScale = overviewScale;
  if (focus) {
    // Wide screens: planet left of centre, moon column right. Tall screens: planet high, column below.
    // Phones: planet in the space between the back link and the moon list.
    const wide = W > H;
    const reach = focus.moons.at(-1).r + 0.6;
    goal = focus.pos;
    anchor = wide ? [W * 0.36, H / 2] : [W / 2, H * 0.3];
    goalScale = (wide ? Math.min(W * 0.6, H) : Math.min(W, H * 0.55)) / 2 * 0.85 / reach;
    if (phone.matches) {
      const top = 100;
      anchor = [W / 2, (top + listTop) / 2];
      goalScale = Math.min(W - 32, listTop - top - 16) / 2 / reach;
    }
  }
  if (landed) {
    // Dive into the part of the moon that matches the page: in light mode the day side, where the night shading
    // hasn't started (sunward of 0.4r); in dark mode the far night side, which is solid slate (beyond 0.7r).
    // Zoom until that band covers the screen.
    const dark = ink[0] > 0.5;
    const [at, half] = dark ? [0.85, 0.15] : [-0.7, 0.3];
    const m = [focus.pos[0] + landed.pos[0], focus.pos[1] + landed.pos[1]], k = 1 + at * landed.size / Math.hypot(...m);
    goal = [m[0] * k, m[1] * k];
    anchor = [W / 2, H / 2];
    goalScale = Math.hypot(W, H) / 2 / (half * landed.size);
  }
  const before = scale;
  cam.logScale += (Math.log(goalScale) - cam.logScale) * ease;
  scale = Math.exp(cam.logScale);
  // Zooming in, ease the goal's position on screen rather than in the world, so it can't overshoot at high zoom
  const keep = (1 - ease) * Math.min(1, before / scale);
  for (let k = 0; k < 2; k++) {
    cam.center[k] = goal[k] - (goal[k] - cam.center[k]) * keep;
    cam.anchor[k] += (anchor[k] - cam.anchor[k]) * ease;
  }
}

// ---------- drawing, in screen pixels ----------
const half = () => Math.hypot(W, H) / 2;
// A ring is worth stroking only if it crosses the screen; at deep zoom most orbits are far off it
const ringOnScreen = (x, y, R) => Math.abs(Math.hypot(x - W / 2, y - H / 2) - R) < half();
function ring(x, y, R, stroke, width = 1) {
  if (!ringOnScreen(x, y, R)) return;
  ctx.beginPath(); ctx.arc(x, y, R, 0, 7);
  ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke();
}
// A plain disc that fades to ink on its night side, which faces away from the sun
function drawBody(w, r, hot) {
  const [x, y] = toScreen(w), R = r * scale;
  if (Math.hypot(x - W / 2, y - H / 2) > R + half()) return;
  ctx.beginPath(); ctx.arc(x, y, R, 0, 7);
  ctx.fillStyle = col.disc; ctx.fill();
  const d = Math.hypot(...w), ux = w[0] / d, uy = w[1] / d;
  const g = ctx.createLinearGradient(x - ux * R, y - uy * R, x + ux * R, y + uy * R);
  for (const [o, c] of col.night) g.addColorStop(o, c);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = hot ? col.accent : col.ink; ctx.lineWidth = 1.25; ctx.stroke();
}
function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const [sx, sy] = toScreen([0, 0]);
  // The sun as the astronomical mark ☉, inside a faint halo ring; zoomed in it fades so the moon column reads
  ctx.globalAlpha = 1 - 0.85 * focusAmt;
  ring(sx, sy, 1.6 * scale, col['ink-3']);
  ctx.beginPath(); ctx.arc(sx, sy, 1.1 * scale, 0, 7);
  ctx.fillStyle = col['paper-2']; ctx.fill();
  ctx.strokeStyle = col.ink; ctx.lineWidth = 1.25; ctx.stroke();
  ctx.beginPath(); ctx.arc(sx, sy, 0.22 * scale, 0, 7);
  ctx.fillStyle = col.ink; ctx.fill();
  ctx.globalAlpha = 1;
  for (const p of planets) ring(sx, sy, p.r * scale, col['ink-3']);
  for (const p of planets) {
    const [px, py] = toScreen(p.pos);
    // Dashed moon rings, faded out when they sit too close together to read (the overview on a phone);
    // diving into a moon they are off-screen anyway
    const rings = 0.7 * Math.min(1, Math.max(0, (0.34 * scale - 2.5) / 2.5));
    if (rings && scale < 3000) {
      ctx.globalAlpha = rings; ctx.setLineDash([2, 3]);
      for (const m of p.moons) ring(px, py, m.r * scale, col['ink-3']);
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }
    for (const m of p.moons) drawBody([p.pos[0] + m.pos[0], p.pos[1] + m.pos[1]], m.size, m === hovered);
    drawBody(p.pos, p.size, p === hovered || p === focus);
  }
  for (const k of rocks) {
    ctx.beginPath();
    for (const q of k.trail) ctx.lineTo(...toScreen(q));
    ctx.globalAlpha = 0.5; ctx.strokeStyle = col['ink-2']; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(...toScreen(k.p), 0.16 * scale, 0, 7);
    ctx.fillStyle = col.ink; ctx.fill();
  }
  // Leader line for the hovered moon: moon → short elbow → its label in the column
  if (hovered && shown?.moons.includes(hovered) && !landed) {
    const [x, y] = hovered.screen, r = hovered.label.getBoundingClientRect();
    const ly = r.top + r.height / 2, lx = r.left - 6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx - 18, ly); ctx.lineTo(lx, ly);
    ctx.globalAlpha = focusAmt; ctx.strokeStyle = col.accent; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
  }
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (document.body.classList.contains('rest')) return requestAnimationFrame(frame);
  resize();
  const ease = snap || jump ? 1 : 1 - Math.exp(-dt * 2.5);
  jump = false;
  // Time slows while zoomed in so the chart holds still while you read
  timeScale += ((landed ? 0 : focus ? 0.1 : 1) * (reduceMotion ? 0.2 : 1) - timeScale) * ease;
  focusAmt += ((focus ? 1 : 0) - focusAmt) * ease;
  t += dt * timeScale;

  for (const p of planets) {
    const a = p.phase + t * K_PLANET * p.r ** -1.5;
    p.pos = [Math.cos(a) * p.r, Math.sin(a) * p.r];
    for (const m of p.moons) {
      const b = m.phase + t * K_MOON * m.r ** -1.5;
      m.pos = [Math.cos(b) * m.r, Math.sin(b) * m.r];
    }
  }
  updateCamera(ease);

  for (const p of planets) {
    const [x, y] = toScreen(p.pos);
    p.screen = [x, y, p.size * scale];
    // In the overview, keep labels clear of the screen edges
    p.w ||= p.label.offsetWidth;
    const lx = Math.min(Math.max(x, 16 + p.w / 2), W - 16 - p.w / 2);
    p.label.style.transform = `translate(${x + (lx - x) * (1 - focusAmt)}px, ${y + p.size * scale + 6}px)`;
  }
  stepRocks(dt * timeScale);
  // Stars pan with the camera, slower than the chart, for depth
  for (const l of starLayers) {
    const off = k => (((cam.anchor[k] - cam.center[k] * scale) * l.speed % TILE) + TILE) % TILE - TILE;
    l.g.setAttribute('transform', `translate(${off(0)} ${off(1)})`);
  }
  if (shown) for (const m of shown.moons) {
    const [x, y] = toScreen([shown.pos[0] + m.pos[0], shown.pos[1] + m.pos[1]]);
    m.screen = [x, y, m.size * scale];
  }
  draw();

  if (belt) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = belt.u;
    gl.uniform2fv(u.u_center, cam.center);
    gl.uniform2fv(u.u_anchor, cam.anchor);
    gl.uniform2f(u.u_res, W, H);
    gl.uniform1f(u.u_scale, scale);
    gl.uniform1f(u.u_zoom, scale / overviewScale);
    gl.uniform1f(u.u_t, t);
    gl.uniform1f(u.u_k, K_PLANET);
    gl.uniform1f(u.u_dpr, dpr);
    gl.uniform3fv(u.u_ink, ink);
    gl.drawArrays(gl.POINTS, 0, belt.n);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
