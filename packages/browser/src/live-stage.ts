import { pageToStage, stageToCanvas } from "./live-map.js";

/**
 * The live view's effects layer, as source for the view's script (`live-page.ts`): a canvas over
 * the picture of the tab, drawn by one WebGL2 fragment shader. The stage is a field of pixels
 * (cells of 7 CSS pixels, rounded squares) lit through a 4x4 ordered dither, so every effect is
 * a level per cell and the Bayer threshold turns it into a pattern of lit cells:
 *
 * - an ambient halo around the picture that drifts while the agent works and breathes while it
 *   thinks;
 * - ripples from a point (a click, a scroll's trail, a file flowing in or out, the end of a run);
 * - a box that converges on the target and marches while the action runs;
 * - a scan line down the picture while the agent reads it;
 * - a dissolve of the picture when it navigates;
 * - a pulsing band around the picture while it waits for the person, or looks stuck.
 *
 * Boxes and points are kept in page coordinates with the scroll they were measured at, and mapped
 * onto the picture on every frame (`live-map.ts`), so they stay on their element as the page
 * scrolls. The loop runs only while something moves: it stops when the view is hidden, and when
 * the agent is idle with no effect left. With reduced motion the shader draws still frames, on
 * demand: boxes and colors, no ripple, scan or dissolve. Without WebGL2 the page keeps its CSS
 * ring and ripples (the caller's `css` hooks). No library: the shader and the loop are below.
 */

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
uniform float uCell, uTime, uAmb, uBoxAmt, uScan, uDis, uEdge, uStill;
uniform vec4 uView, uShell, uBox;
uniform vec3 uTone, uBoxTone, uScanTone, uDisTone, uEdgeTone;
uniform vec4 uRip[8];
uniform vec3 uRipTone[8];

// The 4x4 ordered dither: a cell lights when its level passes its threshold.
const int ORDER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
float threshold(vec2 cell) {
  ivec2 q = ivec2(mod(cell, 4.0));
  return (float(ORDER[q.y * 4 + q.x]) + 0.5) / 16.0;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float smoothNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Signed distance from p to a box given as (x, y, w, h): negative inside.
float boxDistance(vec2 p, vec4 b) {
  vec2 q = abs(p - (b.xy + 0.5 * b.zw)) - 0.5 * b.zw;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
void take(float level, vec3 tone, inout float best, inout vec3 color) {
  if (level > best) { best = level; color = tone; }
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / uCell);
  vec2 mid = (cell + 0.5) * uCell;
  vec2 local = gl_FragCoord.xy / uCell - cell - 0.5;
  float toView = boxDistance(mid, uView);
  bool onPicture = toView < 0.0;
  // The ambient field and the edge go around the whole window (the picture and its address bar).
  float toShell = boxDistance(mid, uShell);
  float t = uStill > 0.5 ? 0.0 : uTime;
  float best = 0.0;
  vec3 color = uTone;

  if (toShell > 0.0 && uAmb > 0.001) {
    float drift = smoothNoise(mid / (13.0 * uCell) + vec2(t * 0.06, t * 0.04)) * 0.65
                + smoothNoise(mid / (4.5 * uCell) - vec2(t * 0.09)) * 0.35;
    float near = exp(-toShell / (8.5 * uCell));
    take(uAmb * (0.2 + 0.8 * near) * drift, uTone, best, color);
  }
  if (uEdge > 0.001) {
    float band = exp(-abs(toShell - 1.2 * uCell) / (1.5 * uCell));
    float pulse = uStill > 0.5 ? 0.85 : 0.62 + 0.38 * sin(t * 4.2);
    take(uEdge * band * pulse, uEdgeTone, best, color);
  }
  for (int i = 0; i < 8; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (r.z < 0.0 || age < 0.0 || age > 1.4) continue;
    float d = length(mid - r.xy);
    float ring = exp(-pow((d - age * r.w) / (2.0 * uCell), 2.0));
    float core = exp(-d / (2.4 * uCell)) * max(0.0, 1.0 - age * 3.0);
    take((ring + core) * (1.0 - age / 1.4), uRipTone[i], best, color);
  }
  if (uBoxAmt > 0.001) {
    float d = boxDistance(mid, uBox);
    float edge = exp(-pow(d / (1.1 * uCell), 2.0));
    float glow = 0.3 * exp(-max(d, 0.0) / (4.0 * uCell)) * step(0.0, d);
    float march = uStill > 0.5 ? 1.0 : 0.72 + 0.28 * sin((mid.x + mid.y) / (16.0 * uCell / 7.0) - t * 6.0);
    take(uBoxAmt * (edge * march + glow), uBoxTone, best, color);
  }
  if (uScan > -0.5 && onPicture) {
    float d = mid.y - uScan;
    take(exp(-pow(d / (1.4 * uCell), 2.0)) + 0.4 * exp(-max(d, 0.0) / (9.0 * uCell)) * step(0.0, d), uScanTone, best, color);
  }
  if (uDis > -0.5 && onPicture) {
    float h = hash(cell + 7.0);
    take(1.25 * smoothstep(uDis - 0.22, uDis, h) * (1.0 - smoothstep(uDis, uDis + 0.22, h)), uDisTone, best, color);
  }

  float lit = step(threshold(cell), best);
  // A rounded square in the middle of the cell, with a gap around it.
  vec2 q = abs(local) - vec2(0.24);
  float shape = 1.0 - smoothstep(-0.03, 0.03, length(max(q, 0.0)) - 0.11);
  float alpha = lit * shape * clamp(best * 1.3, 0.38, 1.0) * (onPicture ? 0.8 : 1.0);
  outColor = vec4(color * alpha, alpha);
}`;

/**
 * The effects engine as page source: `createStage(o)` returns its API. `o` has `stage` (the
 * element the canvas covers), `canvas`, `view()` (the picture's rectangle on the stage, CSS
 * pixels), `shell()` (the window drawn around it), `frame()` (the latest frame's geometry), `reduce` (reduced motion), `tone(name)` (an
 * RGB triple from a theme token) and `css` (the fallback's hooks, used without WebGL2).
 */
export function stageScript(): string {
  return `
${pageToStage.toString()}
${stageToCanvas.toString()}
function createStage(o) {
  const VS = ${JSON.stringify(VERTEX)};
  const FS = ${JSON.stringify(FRAGMENT)};
  const CELL = 7;
  const reduce = o.reduce;
  const fx = {
    amb: 0, ambT: 0.2, tone: o.tone("agent"), toneT: o.tone("agent"), breathe: false, live: false,
    rips: [], focus: null, boxAmt: 0, boxAmtT: 0, boxTone: o.tone("agent"),
    scan: null, dis: null, edge: 0, edgeT: 0, edgeTone: o.tone("human"),
  };
  let gl = null, U = {}, W = 1, H = 1, dpr = 1, raf = 0;
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;
  const stats = { frames: 0, ms: 0 };
  const FAST_MS = 33;
  const SLOW_MS = 200;
  function init() {
    try {
      gl = o.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
    } catch { gl = null; }
    if (!gl) return false;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      for (const n of ["uCell", "uTime", "uAmb", "uBoxAmt", "uScan", "uDis", "uEdge", "uStill", "uView", "uShell", "uBox", "uTone", "uBoxTone", "uScanTone", "uDisTone", "uEdgeTone", "uRip", "uRipTone"])
        U[n] = gl.getUniformLocation(prog, n);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } catch (error) {
      console.warn("turno live view: no WebGL effects", error);
      gl = null;
      return false;
    }
    o.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); gl = null; o.css.fallback(true); });
    return true;
  }
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = o.stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width * dpr));
    H = Math.max(1, Math.round(r.height * dpr));
    if (gl) { o.canvas.width = W; o.canvas.height = H; }
    wake();
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  const near = (a, b) => Math.abs(a - b) < 0.004;
  /** A page box or point on the stage now, or null without a frame. */
  function onStage(p, scroll) { return pageToStage(p, scroll, o.frame(), o.view()); }
  function focusRect(now) {
    const f = fx.focus;
    if (!f) return null;
    const to = onStage(f.box, f.scroll);
    if (!to) return null;
    const pad = 3;
    const b = { x: to.x - pad, y: to.y - pad, w: to.w + 2 * pad, h: to.h + 2 * pad };
    if (!f.converge || reduce) return b;
    const k = Math.min(1, (now - f.t) / 0.45);
    const e = 1 - Math.pow(1 - k, 3);
    const from = { x: b.x - 70, y: b.y - 50, w: b.w + 140, h: b.h + 100 };
    return { x: lerp(from.x, b.x, e), y: lerp(from.y, b.y, e), w: lerp(from.w, b.w, e), h: lerp(from.h, b.h, e) };
  }
  function ripplePoint(r) {
    if (r.at) return onStage(r.at, r.scroll);
    const v = o.view();
    return v.w ? { x: v.x + v.w * r.u, y: v.y + v.h * r.v, w: 0, h: 0 } : null;
  }
  /**
   * How the loop goes on: "fast" (30 frames a second) while a ripple, a scan, a dissolve, a box
   * or a fade moves; "slow" (5 frames a second) while only the ambient field drifts, breathes or
   * pulses, which changes a few cells a second; "" when nothing moves, which stops it.
   */
  function pace(now) {
    if (reduce) return "";
    if (fx.scan || fx.dis || fx.rips.some((r) => now - r.t < 1.4)) return "fast";
    if (fx.focus && now - fx.focus.t < 0.5) return "fast";
    if (!near(fx.boxAmt, fx.boxAmtT) || !near(fx.edge, fx.edgeT) || fx.tone.some((c, i) => !near(c, fx.toneT[i]))) return "fast";
    if (fx.live || fx.breathe || fx.edgeT > 0.01 || fx.focus) return "slow";
    return near(fx.amb, fx.ambT) ? "" : "fast";
  }
  function draw() {
    const began = performance.now();
    const now = clock();
    // Eases by time, not by frame: the same at 10 frames a second as at 30.
    const dt = Math.min(0.25, Math.max(0, now - (last || now)));
    last = now;
    const ease = (rate) => (reduce ? 1 : 1 - Math.pow(1 - rate, dt * 60));
    const k = ease(0.08);
    fx.amb = lerp(fx.amb, fx.ambT * (fx.breathe && !reduce ? 0.72 + 0.28 * Math.sin(now * 2.4) : 1), k);
    fx.boxAmt = lerp(fx.boxAmt, fx.boxAmtT, ease(0.16));
    fx.edge = lerp(fx.edge, fx.edgeT, k);
    for (let i = 0; i < 3; i++) fx.tone[i] = lerp(fx.tone[i], fx.toneT[i], k);
    fx.rips = fx.rips.filter((r) => now - r.t < 1.4);
    const view = o.view();
    const box = focusRect(now);
    o.css.place(box);
    if (!gl) return;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.uCell, CELL * dpr);
    gl.uniform1f(U.uTime, now);
    gl.uniform1f(U.uStill, reduce ? 1 : 0);
    gl.uniform1f(U.uAmb, fx.amb);
    gl.uniform3fv(U.uTone, fx.tone);
    gl.uniform4fv(U.uView, view.w ? stageToCanvas(view, dpr, H) : [0, 0, 0, 0]);
    const shell = o.shell();
    gl.uniform4fv(U.uShell, shell.w ? stageToCanvas(shell, dpr, H) : [0, 0, 0, 0]);
    gl.uniform4fv(U.uBox, box ? stageToCanvas(box, dpr, H) : [-9999, -9999, 0, 0]);
    gl.uniform1f(U.uBoxAmt, box ? fx.boxAmt : 0);
    gl.uniform3fv(U.uBoxTone, fx.boxTone);
    let scan = -1;
    if (fx.scan && view.w) {
      const p = Math.min(1, (now - fx.scan.t) / fx.scan.s);
      scan = H - (view.y + view.h * p) * dpr;
      if (p >= 1) fx.scan = null;
    }
    gl.uniform1f(U.uScan, scan);
    gl.uniform3fv(U.uScanTone, o.tone("read"));
    let dis = -1;
    if (fx.dis) {
      const p = Math.min(1, (now - fx.dis.t) / fx.dis.s);
      dis = -0.25 + 1.5 * p;
      if (p >= 0.5 && fx.dis.mid) { const m = fx.dis.mid; fx.dis.mid = null; m(); }
      if (p >= 1) fx.dis = null;
    }
    gl.uniform1f(U.uDis, dis);
    gl.uniform3fv(U.uDisTone, o.tone("agent"));
    gl.uniform1f(U.uEdge, fx.edge);
    gl.uniform3fv(U.uEdgeTone, fx.edgeTone);
    const rp = new Float32Array(32).fill(-1);
    const rc = new Float32Array(24);
    fx.rips.slice(-8).forEach((r, i) => {
      const p = ripplePoint(r);
      if (!p) return;
      rp.set([p.x * dpr, H - p.y * dpr, r.t, r.speed * dpr], i * 4);
      rc.set(r.tone, i * 3);
    });
    gl.uniform4fv(U.uRip, rp);
    gl.uniform3fv(U.uRipTone, rc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    stats.frames++;
    stats.ms += performance.now() - began;
  }
  let slow = 0;
  let drawn = 0;
  let last = 0;
  function loop(at) {
    raf = 0;
    if (document.hidden) return;
    // At most 30 frames a second: on a Mac each frame Chrome composites costs the same whatever
    // the shader does (measured: the canvas at half the pixels cost as much), so fewer frames is
    // what saves. Steps of 7 px cells look the same at 30 frames as at 60.
    if (at - drawn < FAST_MS - 2) { raf = requestAnimationFrame(loop); return; }
    drawn = at;
    draw();
    // Without WebGL the CSS fallback animates itself: one placement per wake is enough.
    const p = gl ? pace(clock()) : "";
    if (p === "fast") raf = requestAnimationFrame(loop);
    else if (p === "slow") slow = setTimeout(() => { slow = 0; wake(); }, SLOW_MS);
  }
  /** Draws again, and keeps the loop going while something moves. */
  function wake() {
    if (raf || document.hidden) return;
    if (slow) { clearTimeout(slow); slow = 0; }
    raf = requestAnimationFrame(loop);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  const ok = init();
  if (!ok) o.css.fallback(true);
  new ResizeObserver(resize).observe(o.stage);
  resize();
  return {
    gl: () => gl !== null,
    stats,
    wake,
    /** The ambient field: its tone, how strong, whether it drifts (live) or breathes (thinking). */
    mood(tone, amb, how) {
      fx.toneT = o.tone(tone);
      fx.ambT = amb;
      fx.live = how === "live";
      fx.breathe = how === "breathe";
      wake();
    },
    /** A box on the target, in page coordinates with its scroll; null takes it away. */
    focus(box, scroll, tone, converge) {
      if (!box) { fx.boxAmtT = 0; fx.focus = null; o.css.ring(null); wake(); return; }
      fx.focus = { box, scroll, t: clock(), converge: converge !== false };
      fx.boxAmtT = 1;
      fx.boxTone = o.tone(tone);
      o.css.ring(tone);
      wake();
    },
    focusTone(tone) { if (fx.focus) { fx.boxTone = o.tone(tone); o.css.ring(tone); wake(); } },
    focused() { return fx.focus; },
    /** A ripple from a page point (at, scroll), or from a place on the picture (u, v: 0 to 1). */
    ripple(r, tone, speed) {
      if (reduce) return;
      const item = { at: r.at || null, scroll: r.scroll || null, u: r.u || 0, v: r.v || 0, t: clock(), tone: o.tone(tone), speed: speed || 240 };
      if (!gl) { const p = ripplePoint(item); if (p) o.css.ripple(p, tone); return; }
      fx.rips.push(item);
      if (fx.rips.length > 8) fx.rips.shift();
      wake();
    },
    scan(seconds) { if (reduce) return; fx.scan = { t: clock(), s: seconds || 1.1 }; wake(); },
    /** The picture dissolves; \`mid\` runs halfway (or at once without the effect). */
    dissolve(mid) {
      if (reduce || !gl) { if (mid) mid(); return; }
      fx.dis = { t: clock(), s: 0.8, mid: mid || null };
      wake();
    },
    edge(amount, tone) { fx.edgeT = amount; fx.edgeTone = o.tone(tone || "human"); o.css.edge(amount > 0.01 ? tone || "human" : null); wake(); },
  };
}
`;
}
