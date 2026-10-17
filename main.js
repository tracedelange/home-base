(() => {
document.body.classList.add('chart');

// Angular speed = K / r^1.5 (Kepler's third law), so outer bodies drift slower
const K_PLANET = 0.25;
const K_MOON = 0.15;
const BEZEL = 25;  // radius of the graduated outer ring, in chart units
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const snap = new URLSearchParams(location.search).has('snap'); // testing: skip camera easing

// ---------- SVG helpers ----------
const SVG = 'http://www.w3.org/2000/svg';
function el(parent, tag, attrs = {}) {
  const e = parent.appendChild(document.createElementNS(SVG, tag));
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
// A plain disc that fades to ink on its night side; the group is rotated so the night side faces away from the sun
function body(parent, r) {
  const g = el(parent, 'g', { class: 'body' });
  el(g, 'circle', { class: 'disc', r });
  el(g, 'circle', { class: 'night', r });
  el(g, 'circle', { class: 'rim', r });
  return g;
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

// ---------- chart, built from the nav markup ----------
const chart = document.getElementById('chart');
// Night-side shading, shared by every body: clear on the sun side, fading to ink on the far limb (+x)
const night = el(el(chart, 'defs'), 'linearGradient', { id: 'night' });
el(night, 'stop', { offset: 0.3, 'stop-opacity': 0 });
el(night, 'stop', { offset: 1, 'stop-opacity': 0.9 });
const world = el(chart, 'g');
const leaders = el(chart, 'g', { class: 'leaders' });

// The sun as the astronomical mark ☉, inside a faint halo ring
el(world, 'circle', { class: 'sun-halo', r: 1.6 });
el(world, 'circle', { class: 'sun-disc', r: 1.1 });
el(world, 'circle', { class: 'sun-core', r: 0.22 });

const planets = [...document.querySelectorAll('#system > li')].map((li, i) => {
  const p = {
    id: li.dataset.id, li, label: li.querySelector('.planet'),
    r: +li.dataset.orbit, size: +li.dataset.size, phase: i * 2.4, pos: [0, 0], screen: [0, 0, 0],
  };
  li.querySelector('.moons').dataset.title = p.label.textContent;
  el(world, 'circle', { class: 'orbit', r: p.r });
  p.g = el(world, 'g');
  p.moons = [...li.querySelectorAll('.moons a')].map((a, j) => {
    const m = { label: a, r: p.size + 0.7 + j * 0.34, size: 0.11 + 0.05 * (j % 3), phase: j * 2.1, pos: [0, 0], screen: [0, 0, 0] };
    el(p.g, 'circle', { class: 'moon-orbit', r: m.r });
    m.g = el(p.g, 'g');
    body(m.g, m.size);
    m.line = el(leaders, 'polyline');
    for (const [ev, on] of [['pointerenter', 1], ['pointerleave', 0], ['focus', 1], ['blur', 0]])
      a.addEventListener(ev, () => setHover(on ? m : null));
    return m;
  });
  body(p.g, p.size);
  return p;
});

// ---------- belt: stippled ink dots, orbiting on the GPU ----------
const canvas = document.querySelector('canvas');
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
    const r = Math.random() < .8 ? 22.3 + gauss() * 1.6 : rand(20.5, BEZEL - 1.2);  // belt, then sparse scatter (clear of Projects' moons)
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
// Belt ink follows the theme tokens
let ink = [0, 0, 0];
const readInk = () => {
  const h = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  ink = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
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
let focus = null, shown = null, hovered = null, focusAmt = 0, t = 0, timeScale = 1, last = performance.now();
let W = 0, H = 0, dpr = 1, scale = 1, overviewScale = 1;

const toScreen = p => [(p[0] - cam.center[0]) * scale + cam.anchor[0], (p[1] - cam.center[1]) * scale + cam.anchor[1]];

function setFocus(id) {
  const p = planets.find(p => p.id === id) || null;
  if (id && !p) return; // placeholder hashes like #todo are not planets
  focus = p;
  if (p) shown = p;
  document.body.classList.toggle('focusing', !!p);
  for (const q of planets) {
    q.li.classList.toggle('focused', q === p);
    q.g.classList.toggle('focused', q === p);
  }
}
addEventListener('hashchange', () => setFocus(location.hash.slice(1)));
addEventListener('keydown', e => { if (e.key === 'Escape' && focus) location.hash = ''; });
setFocus(location.hash.slice(1));

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
  for (const [x, on] of [[hovered, false], [b, true]]) {
    if (!x) continue;
    x.g.classList.toggle('hover', on);
    x.label.classList.toggle('hot', on);
    x.line?.classList.toggle('hot', on);
  }
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
const rockLayer = el(world, 'g', { class: 'rocks' });
const rocks = [];
function launch(x, y) {
  const p = [(x - cam.anchor[0]) / scale + cam.center[0], (y - cam.anchor[1]) / scale + cam.center[1]];
  const r = Math.hypot(...p);
  if (r < 2) return;
  // Between a falling and an escaping orbit, moving the same way as the planets
  const v = Math.sqrt(GM / r) * (0.5 + Math.random() * 0.9);
  if (rocks.length >= 12) rocks.shift().g.remove();
  const g = el(rockLayer, 'g');
  rocks.push({ p, v: [-p[1] / r * v, p[0] / r * v], trail: [], g, tail: el(g, 'polyline'), dot: el(g, 'circle', { r: 0.16 }) });
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
    if (r < 1.1 || r > BEZEL * 2) { k.g.remove(); rocks.splice(i, 1); continue; }
    k.trail.push(`${k.p[0]},${k.p[1]}`);
    if (k.trail.length > TRAIL) k.trail.shift();
    k.tail.setAttribute('points', k.trail.join(' '));
    k.dot.setAttribute('cx', k.p[0]);
    k.dot.setAttribute('cy', k.p[1]);
  }
}

// ---------- frame ----------
function resize() {
  dpr = Math.min(devicePixelRatio, 2);
  W = innerWidth; H = innerHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  overviewScale = Math.min(W, H) / 2 * 0.94 / BEZEL;
}

function updateCamera(ease) {
  let goal = [0, 0], anchor = [W / 2, H / 2], goalScale = overviewScale;
  if (focus) {
    // Wide screens: planet left of centre, moon column right. Tall screens: planet high, column below.
    const wide = W > H;
    const reach = focus.moons.at(-1).r + 0.6;
    goal = focus.pos;
    anchor = wide ? [W * 0.36, H / 2] : [W / 2, H * 0.3];
    goalScale = (wide ? Math.min(W * 0.6, H) : Math.min(W, H * 0.55)) / 2 * 0.85 / reach;
  }
  for (let k = 0; k < 2; k++) {
    cam.center[k] += (goal[k] - cam.center[k]) * ease;
    cam.anchor[k] += (anchor[k] - cam.anchor[k]) * ease;
  }
  cam.logScale += (Math.log(goalScale) - cam.logScale) * ease;
  scale = Math.exp(cam.logScale);
}

const deg = p => Math.atan2(p[1], p[0]) * 180 / Math.PI;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  resize();
  const ease = snap ? 1 : 1 - Math.exp(-dt * 2.5);
  // Time slows while zoomed in so the chart holds still while you read
  timeScale += ((focus ? 0.1 : 1) * (reduceMotion ? 0.2 : 1) - timeScale) * ease;
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

  world.setAttribute('transform', `translate(${cam.anchor[0]} ${cam.anchor[1]}) scale(${scale}) translate(${-cam.center[0]} ${-cam.center[1]})`);
  for (const p of planets) {
    p.g.setAttribute('transform', `translate(${p.pos[0]} ${p.pos[1]})`);
    p.g.lastChild.setAttribute('transform', `rotate(${deg(p.pos)})`);
    for (const m of p.moons) m.g.setAttribute('transform', `translate(${m.pos[0]} ${m.pos[1]}) rotate(${deg([p.pos[0] + m.pos[0], p.pos[1] + m.pos[1]])})`);
    const [x, y] = toScreen(p.pos);
    p.screen = [x, y, p.size * scale];
    p.label.style.transform = `translate(${x}px, ${y + p.size * scale + 6}px)`;
  }
  // Leader lines: moon → short elbow → its label in the column
  stepRocks(dt * timeScale);
  // Stars pan with the camera, slower than the chart, for depth
  for (const l of starLayers) {
    const off = k => (((cam.anchor[k] - cam.center[k] * scale) * l.speed % TILE) + TILE) % TILE - TILE;
    l.g.setAttribute('transform', `translate(${off(0)} ${off(1)})`);
  }
  leaders.style.opacity = focusAmt;
  if (shown) for (const m of shown.moons) {
    const [x, y] = toScreen([shown.pos[0] + m.pos[0], shown.pos[1] + m.pos[1]]);
    m.screen = [x, y, m.size * scale];
    const r = m.label.getBoundingClientRect();
    const ly = r.top + r.height / 2, lx = r.left - 6;
    m.line.setAttribute('points', `${x},${y} ${lx - 18},${ly} ${lx},${ly}`);
  }

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
