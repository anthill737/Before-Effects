/**
 * WGSL sources. Conventions (docs/01-architecture.md):
 *   - Working textures are rgba16float, scene-linear (sRGB/Rec.709 primaries), premultiplied alpha.
 *   - Coverage textures (rasterised paths and masks) are single-channel 0..1.
 *   - pcg_hash/rand01 must stay bit-identical to packages/core/src/rng.ts.
 */
import { RIPPLE_MAX_DROPS } from "@be/core";

export const COMMON = /* wgsl */ `
fn pcg_hash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand01(seed: u32, k: u32) -> f32 {
  let h = pcg_hash(pcg_hash(seed) ^ k);
  return f32(h >> 8u) / 16777216.0;
}
fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

// Full-screen triangle; uv (0,0) is the top-left texel.
fn fullscreen(vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return o;
}
`;

/** Colorise a coverage texture: out = coverage * color (color already linear premultiplied). */
export const COLORIZE = /* wgsl */ `
${COMMON}
struct U { color: vec4f };
@group(0) @binding(0) var cov: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(cov, samp, i.uv, 0.0).r;
  return u.color * c;
}
`;

/** Multiply a layer by a coverage mask (mask combine is done before this pass). */
export const APPLY_MASK = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var mask: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, i.uv, 0.0) * textureSampleLevel(mask, samp, i.uv, 0.0).r;
}
`;

/**
 * Combine one mask's coverage into the running mask (After Effects mask modes).
 * mode: 0 add(union) 1 subtract 2 intersect 3 lighten 4 darken 5 difference.
 */
export const MASK_COMBINE = /* wgsl */ `
${COMMON}
struct U { mode: u32, inverted: u32, opacity: f32, first: u32 };
@group(0) @binding(0) var acc: texture_2d<f32>;
@group(0) @binding(1) var m: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  var b = textureSampleLevel(m, samp, i.uv, 0.0).r;
  if (u.inverted == 1u) { b = 1.0 - b; }
  b = b * u.opacity;
  // The first mask in Subtract/Intersect mode starts from "everything visible", as in AE.
  var a = textureSampleLevel(acc, samp, i.uv, 0.0).r;
  if (u.first == 1u) { a = select(0.0, 1.0, u.mode == 1u || u.mode == 2u); }
  var r = a;
  switch (u.mode) {
    case 0u: { r = a + b - a * b; }
    case 1u: { r = a * (1.0 - b); }
    case 2u: { r = a * b; }
    case 3u: { r = max(a, b); }
    case 4u: { r = min(a, b); }
    case 5u: { r = abs(a - b); }
    default: { r = a; }
  }
  return vec4f(r, r, r, r);
}
`;

/** Separable Gaussian blur on premultiplied colour. dir = (1/w,0) or (0,1/h). */
export const BLUR = /* wgsl */ `
${COMMON}
struct U { dir: vec2f, sigma: f32, radius: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  if (u.sigma <= 0.0) { return textureSampleLevel(src, samp, i.uv, 0.0); }
  var sum = vec4f(0.0);
  var wsum = 0.0;
  let r = i32(ceil(u.radius));
  // Pairs of taps using bilinear filtering would halve the cost; clarity first.
  for (var k = -r; k <= r; k++) {
    let x = f32(k);
    let w = exp(-0.5 * x * x / (u.sigma * u.sigma));
    sum += textureSampleLevel(src, samp, i.uv + u.dir * x, 0.0) * w;
    wsum += w;
  }
  return sum / wsum;
}
`;

/** Downsample by 2 with a 4-tap box (used to keep huge blurs cheap). */
export const DOWNSAMPLE = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f { return textureSampleLevel(src, samp, i.uv, 0.0); }
`;

/** Glow combine: out = src + blurred * intensity (blurred taken from a thresholded copy). */
export const GLOW_COMBINE = /* wgsl */ `
${COMMON}
struct U { intensity: f32, _p0: f32, _p1: f32, _p2: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var blurred: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = textureSampleLevel(src, samp, i.uv, 0.0);
  let g = textureSampleLevel(blurred, samp, i.uv, 0.0) * u.intensity;
  // Additive light; alpha grows with the glow so it composites outside the original shape.
  return vec4f(s.rgb + g.rgb, min(1.0, s.a + g.a));
}
`;

/**
 * Melt: the picture sags and drips downward. Each column slides down by its own amount — broad
 * slumps plus thin drips — and is smeared along the way, so streaks trail behind. What slides away
 * at the top leaves it empty. Procedural (a look, not a simulation).
 */
export const MELT = /* wgsl */ `
${COMMON}
struct U { amount: f32, drip: f32, seed: f32, reach: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
fn h1(x: f32) -> f32 { return fract(sin(x * 127.1 + u.seed * 311.7) * 43758.5453); }
fn n1(x: f32) -> f32 { let i = floor(x); let f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let x = i.uv.x;
  let broad = n1(x * 5.0) * 0.6 + n1(x * 13.0 + 7.0) * 0.4;
  let drips = pow(n1(x * 47.0 + 3.0), 6.0) * u.drip;
  // How far this column has slid (uv), growing with the amount; drips run ahead.
  let d = u.amount * u.reach * (0.3 + 0.6 * broad + 1.1 * drips);
  var acc = vec4f(0.0);
  for (var k = 0; k < 8; k++) {
    // Smear: samples from where the column was, a little way back up its path.
    let y = i.uv.y - d * (1.0 - f32(k) * 0.025);
    if (y >= 0.0 && y <= 1.0) { acc += textureSampleLevel(src, samp, vec2f(x, y), 0.0); }
  }
  return acc / 8.0;
}
`;

/**
 * Ripple: rings of water spread from each drop and bend the picture under them (refraction: each
 * point shows the picture a little way along the wave's slope), with light added on the crests.
 * Procedural (a look, not a simulation). The drops — where, how long ago, how strong — come from the
 * CPU (core rippleDrops), so a frame always looks the same.
 */
export const RIPPLE = /* wgsl */ `
${COMMON}
struct U {
  size: vec2f,          // texture size (px)
  strength: f32,        // how far the waves bend the picture (px)
  wavelength: f32,      // ring spacing (px)
  speed: f32,           // px per second
  fade: f32,            // weakening per px away from the drop
  rings: f32,           // rings per drop; 0 = keeps rippling
  count: f32,           // drops in use
  light: vec4f,         // crest light: sRGB colour, amount
  drops: array<vec4f, ${RIPPLE_MAX_DROPS}>,  // x, y (px), seconds since it landed, strength
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let p = i.uv * u.size;
  let soft = u.wavelength * 0.5;
  let train = u.rings * u.wavelength;
  var bend = vec2f(0.0);
  var crest = 0.0;
  let count = min(u32(u.count), ${RIPPLE_MAX_DROPS}u);
  for (var k = 0u; k < count; k++) {
    let d = u.drops[k];
    let delta = p - d.xy;
    let r = length(delta);
    // How far this point is behind the leading ring, which left the drop d.z seconds ago.
    let behind = u.speed * d.z - r;
    if (behind <= 0.0) { continue; }
    // A soft leading ring, calm right at the drop, and (with a ring count) a soft last ring.
    var env = smoothstep(0.0, soft, behind) * smoothstep(0.0, soft, r);
    if (u.rings > 0.0) { env = env * (1.0 - smoothstep(train - soft, train, behind)); }
    let a = env * d.w * exp(-u.fade * r);
    let phase = behind / u.wavelength * 6.2831853;
    // The slope of the water bends the light: shift along the ring's direction by the slope.
    bend += delta / max(r, 1e-3) * (cos(phase) * a);
    crest += smoothstep(0.5, 1.0, sin(phase)) * a;
  }
  // Overlapping drops never bend further than the strength (the bounds the effect declares).
  bend = bend / max(1.0, length(bend));
  let c = textureSampleLevel(src, samp, (p - bend * u.strength) / u.size, 0.0);
  // Light only where there is picture (premultiplied: scaled by coverage).
  let glow = srgb_to_linear(u.light.rgb) * (u.light.a * min(crest, 1.5) * c.a);
  return vec4f(c.rgb + glow, c.a);
}
`;

/**
 * Glitch: one moment of a digital glitch. Strips of the picture jump sideways, square blocks show a
 * coarse copy of the picture nearby, red and blue split apart, the brightness flickers and scanlines
 * roll down. Which strips and blocks break comes from this moment's key (core glitchAt), so a frame
 * always looks the same. Between bursts (strength 0) only the scanlines remain.
 */
export const GLITCH = /* wgsl */ `
${COMMON}
struct U {
  size: vec2f,          // texture size (px)
  strength: f32,        // how hard it glitches now (0 between bursts)
  slice: f32,           // strip height (px)
  shift: f32,           // how far strips jump (px)
  split: f32,           // colour split (px)
  blocks: f32,          // share of blocks that break up (0..1)
  scan: f32,            // scanline darkness (0..1)
  scanPeriod: f32,      // px from one scanline to the next
  scanOffset: f32,      // px the scanlines have rolled
  flicker: f32,         // brightness now
  key: u32,             // this moment's random pattern
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
fn rnd(stream: u32, n: u32) -> f32 { return rand01(u.key ^ stream, n); }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  var p = i.uv * u.size;
  let s = u.strength;
  var c = vec4f(0.0);
  if (s > 0.0) {
    // Strips jump sideways: thin ones often, wide ones (three strips tall) now and then.
    let row = u32(max(floor(p.y / u.slice), 0.0));
    let band = u32(max(floor(p.y / (u.slice * 3.0)), 0.0));
    if (rnd(1u, row) < s * 0.45) { p.x += (rnd(2u, row) * 2.0 - 1.0) * u.shift * s; }
    if (rnd(3u, band) < s * 0.25) { p.x += (rnd(4u, band) * 2.0 - 1.0) * u.shift * s * 0.5; }
    // Blocks break up: a coarse, pixelated copy of a block up to two blocks away.
    let bs = u.slice * 2.0;
    let cell = vec2u(max(floor(p / bs), vec2f(0.0)));
    let id = (cell.x * 73856093u) ^ (cell.y * 19349663u);
    if (rnd(5u, id) < u.blocks * s * 0.35) {
      let jump = floor(vec2f(rnd(6u, id), rnd(7u, id)) * 5.0) - 2.0;
      let coarse = bs / 6.0;
      p = floor((p + jump * bs) / coarse) * coarse + coarse * 0.5;
    }
    // Red and blue pull apart. Premultiplied: each channel keeps its own coverage, so the result stays valid.
    let d = vec2f(u.split * s, 0.0);
    let cr = textureSampleLevel(src, samp, (p + d) / u.size, 0.0);
    let cg = textureSampleLevel(src, samp, p / u.size, 0.0);
    let cb = textureSampleLevel(src, samp, (p - d) / u.size, 0.0);
    c = vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
  } else {
    c = textureSampleLevel(src, samp, i.uv, 0.0);
  }
  let line = 0.5 + 0.5 * cos((i.uv.y * u.size.y + u.scanOffset) * 6.2831853 / u.scanPeriod);
  return vec4f(c.rgb * ((1.0 - u.scan * line) * u.flicker), c.a);
}
`;

/** Threshold: keep only parts brighter than the threshold (for glow). */
export const THRESHOLD = /* wgsl */ `
${COMMON}
struct U { threshold: f32, _p0: f32, _p1: f32, _p2: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = textureSampleLevel(src, samp, i.uv, 0.0);
  if (u.threshold <= 0.0) { return s; }
  let l = luma(s.rgb / max(s.a, 1e-5));
  let k = smoothstep(u.threshold, u.threshold + 0.1, l);
  return s * k;
}
`;

/**
 * Draw a layer texture into the composition through its 4x4 matrix.
 * The quad covers the layer texture's rect in layer space. An optional track matte (comp-space
 * texture) is applied per pixel.
 */
export const LAYER_COMPOSITE = /* wgsl */ `
${COMMON}
struct U {
  mvp: mat4x4f,           // layer space -> clip space
  rect: vec4f,            // x, y, w, h of the layer texture in layer space
  opacity: f32,
  matteMode: u32,         // 0 none, 1 alpha, 2 alpha inverted, 3 luma, 4 luma inverted
  compSize: vec2f,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var matte: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
  var c = array<vec2f, 6>(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(0.0,1.0), vec2f(1.0,0.0), vec2f(1.0,1.0));
  let t = c[vi];
  let p = vec2f(u.rect.x + t.x * u.rect.z, u.rect.y + t.y * u.rect.w);
  var o: V;
  o.pos = u.mvp * vec4f(p, 0.0, 1.0);
  o.uv = t;
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  var c = textureSampleLevel(src, samp, i.uv, 0.0) * u.opacity;
  if (u.matteMode != 0u) {
    let m = textureLoad(matte, vec2i(i.pos.xy), 0);
    var k = m.a;
    if (u.matteMode == 3u || u.matteMode == 4u) { k = luma(m.rgb); }
    if (u.matteMode == 2u || u.matteMode == 4u) { k = 1.0 - k; }
    c = c * clamp(k, 0.0, 1.0);
  }
  return c;
}
`;

/**
 * A layer mixed with what's below it by a blend mode that reads the picture below (overlay, soft
 * light, colour dodge, hue, …), drawn over a copy of that picture (`backdrop`) without hardware
 * blending. Premultiplied in and out. Modes 1–13 use the W3C / Photoshop formulas on the picture as
 * displayed (sRGB-encoded, clamped to 0–1), as After Effects does by default; 14–16 repeat the
 * hardware Add, Screen and Multiply (on linear light) for adjustment layers.
 *
 * `adjust` = 1: an adjustment layer. `src` is the adjusted picture (the whole composition), the matte
 * texture is where it applies (alpha), and the result is the picture below moved toward the adjusted
 * (blended) one by that coverage times the opacity.
 */
export const LAYER_BLEND = /* wgsl */ `
${COMMON}
struct U {
  mvp: mat4x4f,
  rect: vec4f,
  opacity: f32,
  matteMode: u32,
  compSize: vec2f,
  mode: u32,
  adjust: u32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var matte: texture_2d<f32>;
@group(0) @binding(4) var backdrop: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
  var c = array<vec2f, 6>(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(0.0,1.0), vec2f(1.0,0.0), vec2f(1.0,1.0));
  let t = c[vi];
  let p = vec2f(u.rect.x + t.x * u.rect.z, u.rect.y + t.y * u.rect.w);
  var o: V;
  o.pos = u.mvp * vec4f(p, 0.0, 1.0);
  o.uv = t;
  return o;
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }
fn clipColor(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var o = c;
  if (n < 0.0) { o = vec3f(l) + (o - vec3f(l)) * l / max(l - n, 1e-6); }
  if (x > 1.0) { o = vec3f(l) + (o - vec3f(l)) * (1.0 - l) / max(x - l, 1e-6); }
  return o;
}
fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + vec3f(l - lum(c))); }
fn sat(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn setSat(c: vec3f, s: f32) -> vec3f {
  let mn = min(c.r, min(c.g, c.b));
  let mx = max(c.r, max(c.g, c.b));
  if (mx <= mn) { return vec3f(0.0); }
  return (c - vec3f(mn)) * s / (mx - mn);
}
fn screen3(b: vec3f, s: vec3f) -> vec3f { return b + s - b * s; }
fn hardLight(b: vec3f, s: vec3f) -> vec3f {
  return select(screen3(b, 2.0 * s - vec3f(1.0)), b * (2.0 * s), s <= vec3f(0.5));
}
fn softLight(b: vec3f, s: vec3f) -> vec3f {
  let d = select(sqrt(b), ((16.0 * b - vec3f(12.0)) * b + vec3f(4.0)) * b, b <= vec3f(0.25));
  return select(b + (2.0 * s - vec3f(1.0)) * (d - b), b - (vec3f(1.0) - 2.0 * s) * b * (vec3f(1.0) - b), s <= vec3f(0.5));
}
fn dodge(b: f32, s: f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - s));
}
fn burn(b: f32, s: f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / s);
}
// B(Cb, Cs) on display-encoded colour in 0–1.
fn mixColor(b: vec3f, s: vec3f, mode: u32) -> vec3f {
  switch (mode) {
    case 1u: { return hardLight(s, b); }                                         // overlay
    case 2u: { return softLight(b, s); }
    case 3u: { return hardLight(b, s); }
    case 4u: { return vec3f(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b)); }
    case 5u: { return vec3f(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b)); }
    case 6u: { return min(b, s); }                                               // darken
    case 7u: { return max(b, s); }                                               // lighten
    case 8u: { return abs(b - s); }                                              // difference
    case 9u: { return b + s - 2.0 * b * s; }                                     // exclusion
    case 10u: { return setLum(setSat(s, sat(b)), lum(b)); }                      // hue
    case 11u: { return setLum(setSat(b, sat(s)), lum(b)); }                      // saturation
    case 12u: { return setLum(s, lum(b)); }                                      // color
    case 13u: { return setLum(b, lum(s)); }                                      // luminosity
    default: { return s; }
  }
}
// Source s over backdrop b (both premultiplied, linear) with blend mode \`mode\`.
fn blended(s: vec4f, b: vec4f, mode: u32) -> vec4f {
  let a = s.a + b.a * (1.0 - s.a);
  if (mode == 14u) { return vec4f(s.rgb + b.rgb, a); }                          // add (as hardware)
  if (mode == 15u) { return vec4f(s.rgb + b.rgb * (vec3f(1.0) - s.rgb), a); }   // screen (as hardware)
  if (mode == 16u) { return vec4f(s.rgb * b.rgb + b.rgb * (1.0 - s.a), a); }    // multiply (as hardware)
  if (s.a <= 0.0) { return b; }
  let cs = s.rgb / s.a;
  if (mode == 0u || b.a <= 0.0) { return vec4f(s.rgb + b.rgb * (1.0 - s.a), a); }
  let cb = b.rgb / b.a;
  let m = srgb_to_linear(clamp(mixColor(clamp(linear_to_srgb(cb), vec3f(0.0), vec3f(1.0)), clamp(linear_to_srgb(cs), vec3f(0.0), vec3f(1.0)), mode), vec3f(0.0), vec3f(1.0)));
  let csp = (1.0 - b.a) * cs + b.a * m;
  return vec4f(s.a * csp + (1.0 - s.a) * b.rgb, a);
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let b = textureLoad(backdrop, vec2i(i.pos.xy), 0);
  var s = textureSampleLevel(src, samp, i.uv, 0.0);
  var k = 1.0;
  if (u.matteMode != 0u) {
    let m = textureLoad(matte, vec2i(i.pos.xy), 0);
    k = m.a;
    if (u.matteMode == 3u || u.matteMode == 4u) { k = luma(m.rgb); }
    if (u.matteMode == 2u || u.matteMode == 4u) { k = 1.0 - k; }
    k = clamp(k, 0.0, 1.0);
  }
  if (u.adjust == 1u) {
    let full = blended(s, b, u.mode);
    return mix(b, select(full, s, u.mode == 0u), k * u.opacity);
  }
  return blended(s * (u.opacity * k), b, u.mode);
}
`;

/**
 * Projector output: for each output pixel, find the content point through the inverse calibration
 * homography, sample the content, then apply output masks and this projector's output colour
 * correction. Mapping and output correction happen here and only here, so they are never applied twice.
 */
export const OUTPUT_WARP = /* wgsl */ `
${COMMON}
struct U {
  hinv: mat3x3f,          // output px -> content px
  contentSize: vec2f,
  outputSize: vec2f,
  gain: vec4f,
  gamma: f32,
  blackLevel: f32,
  encodeSrgb: u32,
  showGrid: u32,
  blend: vec4f,                    // x: other projectors (0 = no blending), y: curve
  others: array<mat3x3f, 7>,       // content px -> each other projector's output px
  otherSizes: array<vec4f, 7>,     // their output sizes (xy)
  mesh: vec4f,                     // residual grid: columns, rows, on (1) / off (0), surface labels on (1)
  labelInfo: vec4f,                // surface label map: content px → label texel scale (xy), size (zw)
};
@group(0) @binding(0) var content: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var outMask: texture_2d<f32>;
@group(0) @binding(4) var keepOff: texture_2d<f32>;   // content-space "keep light off here" areas
@group(0) @binding(5) var meshTex: texture_2d<f32>;   // residual grid over the output: content-px offsets (xy), surface label (z)
@group(0) @binding(6) var labelTex: texture_2d<f32>;  // content space: which surface (house area) each point is on (r × 255)
@group(0) @binding(7) var meshBase: texture_2d<f32>;  // with labels: the main wall's correction at every grid point (xy)
fn contentLabel(cp: vec2f) -> f32 {
  let p = clamp(vec2i(floor(cp * u.labelInfo.xy)), vec2i(0), vec2i(u.labelInfo.zw) - 1);
  return round(textureLoad(labelTex, p, 0).r * 255.0);
}
// Camera-measured alignment: the offset from the homography at this output pixel, bilinear between the
// grid points around it — with surface labels, only those of the surface the point falls on, so a
// correction stops at a depth edge (door, column, roof edge) instead of bleeding across it.
// Mirrors core autoAlign.ts meshOffsetAt.
fn meshOffset(op: vec2f, base: vec2f) -> vec2f {
  if (u.mesh.z < 0.5) { return vec2f(0.0); }
  let n = u.mesh.xy;
  let g = clamp(op / u.outputSize * (n - 1.0), vec2f(0.0), n - 1.0);
  let i0 = vec2i(min(floor(g), n - 2.0));
  let t = g - vec2f(i0);
  var acc = vec3f(0.0);
  var nearest = vec2f(0.0);
  var nw = -1.0;
  for (var k = 0; k < 4; k++) {
    let d = vec2i(k & 1, k >> 1u);
    let v = textureLoad(meshTex, i0 + d, 0);
    let w = select(1.0 - t.x, t.x, d.x == 1) * select(1.0 - t.y, t.y, d.y == 1);
    if (w > nw) { nw = w; nearest = v.xy; }
    if (u.mesh.w > 0.5 && contentLabel(base + v.xy) != round(v.z)) { continue; }
    acc += vec3f(v.xy * w, w);
  }
  if (acc.z > 1e-6) { return acc.xy / acc.z; }
  // None of the four is on this pixel's surface: the main wall's layer, where the pixel is on the wall.
  if (u.mesh.w > 0.5) {
    var accB = vec3f(0.0);
    for (var k = 0; k < 4; k++) {
      let d = vec2i(k & 1, k >> 1u);
      let b = textureLoad(meshBase, i0 + d, 0).xy;
      let w = select(1.0 - t.x, t.x, d.x == 1) * select(1.0 - t.y, t.y, d.y == 1);
      if (contentLabel(base + b) != 0.0) { continue; }
      accB += vec3f(b * w, w);
    }
    if (accB.z > 1e-6) { return accB.xy / accB.z; }
  }
  return nearest;
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
// How far inside a projector's frame a point is (0 at the edge): side and top/bottom distances multiplied.
fn edgeDist(p: vec2f, size: vec2f) -> f32 {
  if (any(p < vec2f(0.0)) || any(p > size)) { return 0.0; }
  return (min(p.x, size.x - p.x) / size.x) * (min(p.y, size.y - p.y) / size.y);
}
fn shaped(e: f32) -> f32 { return select(0.0, pow(e, max(u.blend.y, 0.25)), e > 0.0); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let op = i.uv * u.outputSize;
  let h = u.hinv * vec3f(op, 1.0);
  let cp = h.xy / h.z + meshOffset(op, h.xy / h.z);
  var c = vec4f(0.0);
  if (h.z > 0.0 && all(cp >= vec2f(0.0)) && all(cp <= u.contentSize)) {
    c = textureSampleLevel(content, samp, cp / u.contentSize, 0.0);
    c = c * (1.0 - textureSampleLevel(keepOff, samp, cp / u.contentSize, 0.0).r);
    // Edge blending: this projector's share where others light the same point (mirrors core blendWeight).
    let n = u32(u.blend.x);
    if (n > 0u) {
      let mine = shaped(edgeDist(op, u.outputSize));
      var total = mine;
      for (var k = 0u; k < n; k++) {
        let q = u.others[k] * vec3f(cp, 1.0);
        if (q.z > 0.0) { total += shaped(edgeDist(q.xy / q.z, u.otherSizes[k].xy)); }
      }
      c = c * select(select(0.0, 1.0, mine > 0.0), mine / total, total > 1e-12);
    }
  }
  if (u.showGrid == 1u) {
    let g = abs(fract(cp / 80.0 + 0.5) - 0.5) * 80.0;
    let line = 1.0 - smoothstep(0.0, 1.5, min(g.x, g.y));
    let inside = select(0.0, 1.0, all(cp >= vec2f(0.0)) && all(cp <= u.contentSize));
    c = mix(c, vec4f(0.15, 0.55, 1.0, 1.0), line * inside * 0.8);
  }
  // Output masks mark physical areas where light must be blocked (neighbouring walls, signs, eyes).
  c = c * (1.0 - textureSampleLevel(outMask, samp, i.uv, 0.0).r);
  // Output correction for this projector (linear light), then optional display encoding.
  var rgb = c.rgb * u.gain.rgb;
  rgb = max(rgb, vec3f(0.0));
  rgb = pow(rgb, vec3f(1.0 / max(u.gamma, 0.01)));
  rgb = u.blackLevel + rgb * (1.0 - u.blackLevel);
  if (u.encodeSrgb == 1u) { rgb = linear_to_srgb(rgb); }
  return vec4f(rgb, 1.0);
}
`;

/** Encode a linear premultiplied texture for display/export: unpremultiply? No — composite over a background. */
export const ENCODE = /* wgsl */ `
${COMMON}
struct U { bg: vec4f, keepAlpha: u32, encodeSrgb: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = textureSampleLevel(src, samp, i.uv, 0.0);
  if (u.keepAlpha == 1u) {
    // Straight-alpha output for files that carry transparency (ProRes 4444, PNG).
    let a = s.a;
    var rgb = select(vec3f(0.0), s.rgb / a, a > 1e-6);
    if (u.encodeSrgb == 1u) { rgb = linear_to_srgb(rgb); }
    return vec4f(rgb, a);
  }
  var rgb = s.rgb + u.bg.rgb * (1.0 - s.a);
  if (u.encodeSrgb == 1u) { rgb = linear_to_srgb(rgb); }
  return vec4f(rgb, 1.0);
}
`;

/**
 * "On the building" preview: projected light reflects off the surface in proportion to its colour,
 * so preview = albedo × (ambient + projected light). The photo stands in for albedo; this is an
 * approximation for design, not a surveyed lighting result.
 */
export const BUILDING_PREVIEW = /* wgsl */ `
${COMMON}
struct U { ambient: f32, exposure: f32, refOpacity: f32, _p: f32 };
@group(0) @binding(0) var content: texture_2d<f32>;
@group(0) @binding(1) var reference: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let light = textureSampleLevel(content, samp, i.uv, 0.0).rgb;
  let refc = textureSampleLevel(reference, samp, i.uv, 0.0);
  // Outside the photo (bars around a fitted photo) there's no surface to light.
  let albedo = srgb_to_linear(refc.rgb) * refc.a;
  // Lift dark surfaces slightly so projected light stays visible on very dark photos.
  let surface = mix(vec3f(0.18), albedo, u.refOpacity) * 1.6;
  let rgb = surface * (u.ambient + light * u.exposure);
  return vec4f(linear_to_srgb(rgb), 1.0);
}
`;

/** Imported pixels (sRGB-encoded, straight alpha) → working space (linear, premultiplied). */
export const IMPORT_PIXELS = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, i.uv, 0.0);
  return vec4f(srgb_to_linear(c.rgb) * c.a, c.a);
}
`;
