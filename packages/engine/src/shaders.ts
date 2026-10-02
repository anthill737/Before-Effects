/**
 * WGSL sources. Conventions (docs/01-architecture.md):
 *   - Working textures are rgba16float, scene-linear (sRGB/Rec.709 primaries), premultiplied alpha.
 *   - Coverage textures (rasterised paths and masks) are single-channel 0..1.
 *   - pcg_hash/rand01 must stay bit-identical to packages/core/src/rng.ts.
 */

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
};
@group(0) @binding(0) var content: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var outMask: texture_2d<f32>;
@group(0) @binding(4) var keepOff: texture_2d<f32>;   // content-space "keep light off here" areas
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut { return fullscreen(vi); }
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let op = i.uv * u.outputSize;
  let h = u.hinv * vec3f(op, 1.0);
  let cp = h.xy / h.z;
  var c = vec4f(0.0);
  if (h.z > 0.0 && all(cp >= vec2f(0.0)) && all(cp <= u.contentSize)) {
    c = textureSampleLevel(content, samp, cp / u.contentSize, 0.0);
    c = c * (1.0 - textureSampleLevel(keepOff, samp, cp / u.contentSize, 0.0).r);
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
  let albedo = srgb_to_linear(textureSampleLevel(reference, samp, i.uv, 0.0).rgb);
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
