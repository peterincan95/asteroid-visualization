import { FLOATS_PER_ORBIT, type OrbitData } from "./data";
import { DEFAULT_EFFECTS, effectAmount, type EffectSettings } from "./effects";
import { PLANETS } from "./planets";

/** The view: `x` and `y` are the plot position at the screen's center, `zoom` 1 shows the whole plot. */
export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

/**
 * Which asteroids to show: inclusive ranges of semimajor axis (AU), log10 diameter (km)
 * and eccentricity. Planets and the Sun are never filtered.
 */
export interface OrbitFilter {
  a: [number, number];
  logDiameter: [number, number];
  e: [number, number];
}

/** A filter that hides nothing. */
export const NO_FILTER: OrbitFilter = { a: [-1e9, 1e9], logDiameter: [-1e9, 1e9], e: [-1e9, 1e9] };

/** Whether an orbit (in the GPU layout) passes a filter; mirrors filteredOut() in ORBIT_GLSL. */
export function passesFilter(orbits: Float32Array, index: number, filter: OrbitFilter) {
  const o = index * FLOATS_PER_ORBIT;
  const within = (value: number, [low, high]: [number, number]) => value >= low && value <= high;
  return within(orbits[o + 4]!, filter.a) && within(orbits[o + 9]!, filter.logDiameter) && within(orbits[o + 5]!, filter.e);
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  uniforms: Uniforms;
}

interface Resources {
  points: Program;
  strips: Program;
  downsample: Program;
  blur: Program;
  composite: Program;
  bright: Program;
  streak: Program;
  persist: Program;
  final: Program;
  asteroidPoints: WebGLVertexArrayObject;
  asteroidStrips: WebGLVertexArrayObject;
  /** The planets, then the Sun. */
  bodyPoints: WebGLVertexArrayObject;
  bodyStrips: WebGLVertexArrayObject;
  emptyVao: WebGLVertexArrayObject;
  /** Painted UI panels (see hudPainter.ts), blended in before the screen effects. */
  overlays: WebGLTexture[];
  labels: Program;
  labelVao: WebGLVertexArrayObject;
  labelBuffer: WebGLBuffer;
  labelAtlas: WebGLTexture;
}

interface Targets {
  density: Target;
  trails: Target;
  rings: Target;
  nearA: Target;
  nearB: Target;
  farA: Target;
  farB: Target;
  /** The finished scene, before screen effects. */
  scene: Target;
  /** Phosphor persistence: last frame and this one, swapped each frame. */
  historyA: Target;
  historyB: Target;
  /** Bright parts of the scene at a quarter size, for flares and streaks. */
  brightA: Target;
  brightB: Target;
  streakA: Target;
  streakB: Target;
}

// ---- Distance scale ----------------------------------------------------------------
// Distance from the Sun is drawn as ln(1 + r / R0) / ln(1 + R_EDGE / R0), so the plot's
// edge (1) sits at R_EDGE AU and the main belt (~2.7 AU) lands about halfway out.
export const SCALE_R0_AU = 0.13;
export const SCALE_EDGE_AU = 60;
/** Share of half the screen's shorter side that the plot's edge reaches at zoom 1. */
export const PLOT_FILL = 0.96;

// ---- Colors ------------------------------------------------------------------------
// Body colors themselves are set in colors.ts. The GPU's color table holds up to this many.
const MAX_COLORS = 32;
// Points run through a ramp: black, a dark shade at this share of the hue, the hue
// itself at half brightness, then tints this far toward white at the brightest.
const DARK_SHADE = 0.5;
const LIGHT_TINT = 0.45;
const PEAK_TINT = 0.85;

// ---- Asteroid points ---------------------------------------------------------------
// Width in CSS pixels of the smallest asteroid (MIN_DIAMETER_KM).
const POINT_SIZE = 1.4;
// Width grows with the log of diameter: this many CSS pixels per tenfold increase.
const SIZE_PER_DECADE = 1.6;
const MIN_DIAMETER_KM = 0.5;
// Brightness is set as if the smallest points were this wide, so larger points keep
// their brightness while small ones stay visible.
const LIGHT_BASE_SIZE = 1.7;
// Bigger points spread their light thinner: brightness falls by the size ratio to this power.
const LIGHT_SPREAD = 1.35;
// Large points fade toward their edge by up to this share of their brightness.
const EDGE_SOFTNESS = 0.7;
// Points turn from squares to circles as they grow between these widths in device pixels.
const ROUND_POINT_SIZES = [3, 5];
// Brightness one point adds to the density buffer: higher reads as more opaque.
const POINT_WEIGHT = 0.8;
export const MAX_ZOOM = 64;
// Points grow with zoom, reaching this multiple of their size at the closest zoom.
const MAX_ZOOM_GROWTH = 3;
// Added to a point's brightness for each doubling of zoom.
const ZOOM_BRIGHTNESS = 0.25;
export const MAX_PIXEL_RATIO = 2;

// ---- Trails ------------------------------------------------------------------------
// How far back in time each trail reaches grows with the orbit's size:
// days = TRAIL_DAYS_AT_BELT * (a / TRAIL_BELT_AU) ^ TRAIL_DAYS_POWER, within the limits.
// That gives about 10 days at 0.4 AU, 60 at the main belt and two years at 45 AU.
const TRAIL_DAYS_AT_BELT = 60;
const TRAIL_BELT_AU = 2.7;
const TRAIL_DAYS_POWER = 0.9;
const TRAIL_MIN_DAYS = 10;
const TRAIL_MAX_DAYS = 730;
// Vertices along each trail.
const TRAIL_SAMPLES = 24;
// A trail's width as a share of its asteroid's width.
const TRAIL_WIDTH_SHARE = 0.5;
// Brightness of a trail at its head, before toning.
const TRAIL_WEIGHT = 0.9;
// Trails fade toward their tail by their remaining share to this power.
const TRAIL_FADE_POWER = 1.6;
// How strongly the trail layer shows its colors, from 0 to 1.
const TRAIL_STRENGTH = 0.8;
// Each trail starts at the edge of its own point rather than its center, blending in
// over this many device pixels, so it never shows through the point.
const TRAIL_EDGE_BLEND = 1;

// ---- Planets and the Sun -----------------------------------------------------------
// The Sun and planets use the asteroids' log size scale, then are scaled up by these
// factors so they stand out. Their trails are half their boosted width.
const PLANET_SIZE_BOOST = 1.2;
const SUN_SIZE_BOOST = 2.2;
// Planets are drawn see-through with a soft edge like the asteroids, but don't thin
// their light with size the way large asteroids do. They're dimmer than an asteroid
// because white reaches full brightness sooner than a colored hue. The Sun is solid.
// Both feed the glow.
const PLANET_WEIGHT = 0.45;
const SUN_WEIGHT = 5;
// How each kind of point spreads its light with size and softens its edge.
const ASTEROID_LOOK = { lightSpread: LIGHT_SPREAD, edgeSoftness: EDGE_SOFTNESS };
const PLANET_LOOK = { lightSpread: 0, edgeSoftness: EDGE_SOFTNESS };
const SUN_LOOK = { lightSpread: 0, edgeSoftness: 0 };
// Orbit rings: vertices around each, width in CSS pixels, and gray.
const RING_SAMPLES = 720;
const RING_WIDTH = 1;
const RING_GRAY = 0.22;

// ---- Background --------------------------------------------------------------------
// A radial gradient centered on the Sun. At the default view it reaches the edge color
// at the screen's corners; it moves and scales with the plot as you pan and zoom.
// Bodies are lit on top of it.
export const BACKGROUND_CENTER = "#2a2c3d";
export const BACKGROUND_EDGE = "#0f1014";

// ---- Glow --------------------------------------------------------------------------
const NEAR_GLOW = 0.3;
const FAR_GLOW = 0.75;

// ---- Planet labels -----------------------------------------------------------------
// Labels fade in as you zoom from the first level to the second (1 shows the whole plot).
const LABEL_ZOOM = [2.5, 4];
// The largest named asteroids (listed in asteroids.json) get the same labels, from closer in.
const ASTEROID_LABEL_ZOOM = [4, 6];
// Century Gothic where it's installed; Didact Gothic (loaded in index.html) elsewhere.
const LABEL_FONT_FAMILY = '"Century Gothic", "Didact Gothic", sans-serif';
const LABEL_FONT_WEIGHT = "bold";
// Size and letter spacing in CSS pixels, for asteroid labels; planet labels are scaled up.
const LABEL_FONT_SIZE = 12;
const LABEL_LETTER_SPACING = 4;
const PLANET_LABEL_SCALE = 1.3;
// The leader runs out from the planet's edge (after a gap) to an elbow, then turns to
// underline the name along the orbit. All in CSS pixels.
const LABEL_GAP = 3;
const LABEL_LEADER = 34;
const LABEL_LINE_WIDTH = 1;
// Where the name starts along the underline, how far it sits above it, and how far the
// underline runs past its end.
const LABEL_TEXT_INSET = 8;
const LABEL_TEXT_LIFT = 5;
const LABEL_UNDERLINE_TAIL = 2;
const LABEL_COLOR = "#e8f2fa";
const LABEL_OPACITY = 0.85;

// ---- UI overlays -------------------------------------------------------------------
// How many painted UI panels can be drawn into the display (the player, the filters).
export const OVERLAY_COUNT = 2;

// ---- Screen effects ----------------------------------------------------------------
// Each effect's strength (0 to 1) comes from the effects menu; these set what full
// strength means.
// Light brighter than this (0 to 1) feeds the flares and streaks, fading in up to 1.
const BRIGHT_THRESHOLD = 0.93;
// Chromatic aberration: color fringes grow toward the edges, reaching this share of
// the screen's width at the corners.
const ABERRATION_MAX = 0.006;
// Curvature: how far the corners bulge, and the screen's corner radius in CSS pixels.
const CURVATURE_MAX = 0.15;
const CORNER_RADIUS = 36;
// Scanlines: period in CSS pixels and how dark the gaps get.
const SCANLINE_PERIOD = 3;
const SCANLINE_DEPTH = 0.55;
// Vignette: how much the corners darken.
const VIGNETTE_MAX = 0.85;
// Grain: noise added to each channel.
const GRAIN_MAX = 0.08;
// Anamorphic streaks: horizontal blur passes (steps in quarter-size pixels), each
// fading by this much per tap, then brightened and tinted.
const STREAK_STEPS = [1, 4, 16];
const STREAK_FALLOFF = 0.86;
const STREAK_GAIN = 6;
const STREAK_TINT = "#6fa8ff";
// Lens flare: ghosts mirrored through the screen's center (scale, tint), and a halo ring.
const FLARE_GHOSTS: [number, string][] = [
  [-0.55, "#ffb36b"],
  [-1.3, "#7fd8ff"],
  [-0.3, "#c48bff"],
  [0.6, "#9dffb8"],
];
const FLARE_GAIN = 1.2;
const HALO_RADIUS = 0.3;
const HALO_TINT = "#8fb8ff";
const HALO_GAIN = 0.8;
// Sun starburst: six spikes with six shorter ones between, length in Sun radii at full
// strength, width in CSS pixels.
const SPIKE_LENGTH = 9;
const SPIKE_WIDTH = 0.9;
const STARBURST_GAIN = 0.9;
const STARBURST_TINT = "#fff1d6";
// Phosphor persistence: share of last frame's light kept each frame, from weakest to strongest.
const PERSISTENCE_RANGE = [0.7, 0.96];
// Phosphor mask: how dark the off color stripes get.
const MASK_DEPTH = 0.65;
// Flicker: brightness wobble, and the brightness of the rolling bar.
const FLICKER_MAX = 0.06;
const ROLLING_BAR_MAX = 0.08;

const zoomGrowth = (zoom: number) =>
  Math.min(zoom ** (Math.log(MAX_ZOOM_GROWTH) / Math.log(MAX_ZOOM)), MAX_ZOOM_GROWTH);

// Shared by both orbit programs: per-body attributes, the Kepler solve, size and color channels.
const ORBIT_GLSL = `
layout(location = 0) in vec4 a_frame;   // P.xy, Q.xy: the orbit's axes seen from above
layout(location = 1) in vec4 a_orbit;   // a (AU), e, mean anomaly at epoch (rad), mean motion (rad/day)
layout(location = 2) in vec3 a_extra;   // epoch (days from the reference), log10 diameter, color index
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_time;
uniform float u_pointSize;
uniform float u_decadeSize;
uniform float u_maxSize;
// Multiplies every size in a draw: 1 for asteroids, a boost for the planets and Sun.
uniform float u_sizeScale;
uniform vec3 u_colors[${MAX_COLORS}];
// When u_useChannels is 1, every body writes u_channels instead of its color.
uniform float u_useChannels;
uniform vec4 u_channels;
// When u_useFilter is 1, bodies outside these inclusive ranges aren't drawn.
uniform float u_useFilter;
uniform vec2 u_filterA;
uniform vec2 u_filterLogDiameter;
uniform vec2 u_filterE;
bool filteredOut() {
  if (u_useFilter < 0.5) return false;
  return a_orbit.x < u_filterA.x || a_orbit.x > u_filterA.y
      || a_extra.y < u_filterLogDiameter.x || a_extra.y > u_filterLogDiameter.y
      || a_orbit.y < u_filterE.x || a_orbit.y > u_filterE.y;
}
// Where a filtered-out body's vertices go: outside the view, so nothing is drawn.
const vec4 HIDDEN = vec4(2.0, 2.0, 2.0, 1.0);
const float TAU = 6.28318530718;
const float PI = 3.14159265359;
const float INV_LOG_EDGE = ${(1 / Math.log(1 + SCALE_EDGE_AU / SCALE_R0_AU)).toFixed(8)};
const float R0 = ${SCALE_R0_AU.toFixed(4)};
// Heliocentric position at day t, flattened onto the ecliptic and put on the log scale.
vec2 plotPosition(float t) {
  float a = a_orbit.x;
  float e = a_orbit.y;
  float M = mod(a_orbit.z + a_orbit.w * (t - a_extra.x), TAU);
  float E = e < 0.8 ? M + e * sin(M) : PI;
  for (int step = 0; step < 12; step += 1) {
    E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  }
  vec2 orbital = vec2(a * (cos(E) - e), a * sqrt(1.0 - e * e) * sin(E));
  vec2 position = orbital.x * a_frame.xy + orbital.y * a_frame.zw;
  float r = max(length(position), 1e-6);
  return position * (log(1.0 + r / R0) * INV_LOG_EDGE / r);
}
// Width in device pixels, growing with the log of diameter.
float pointSize() {
  float size = u_pointSize + u_decadeSize * max(a_extra.y - ${Math.log10(MIN_DIAMETER_KM).toFixed(5)}, 0.0);
  return min(size * u_sizeScale, u_maxSize);
}
// Brightness times color in rgb, and brightness alone in alpha, so overlapping bodies
// add up to a mix of their colors weighted by brightness.
vec4 channels() {
  if (u_useChannels > 0.5) return u_channels;
  int index = clamp(int(a_extra.z + 0.5), 0, ${MAX_COLORS - 1});
  return vec4(u_colors[index], 1.0);
}`;

const POINT_VERTEX = `#version 300 es
${ORBIT_GLSL}
uniform float u_lightSize;
uniform float u_lightSpread;
flat out float v_size;
flat out float v_light;
flat out vec4 v_channels;
void main() {
  if (filteredOut()) {
    gl_Position = HIDDEN;
    gl_PointSize = 0.0;
    return;
  }
  float size = pointSize();
  v_size = size;
  v_light = pow(u_lightSize / size, u_lightSpread);
  v_channels = channels();
  // A pixel wider than the point, so pixels it only partly covers are drawn too.
  gl_PointSize = ceil(size) + 1.0;
  gl_Position = vec4(plotPosition(u_time) * u_scale + u_offset, 0.0, 1.0);
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
uniform float u_edgeSoftness;
uniform vec2 u_roundSizes;
flat in float v_size;
flat in float v_light;
flat in vec4 v_channels;
out vec4 color;
void main() {
  // This pixel's offset from the point's center, in pixels.
  vec2 offset = abs(gl_PointCoord - 0.5) * (ceil(v_size) + 1.0);
  float half_size = v_size * 0.5;
  // How much of this pixel a square point covers, so its total light is its exact area.
  vec2 overlap = clamp(min(vec2(half_size), offset + 0.5) - max(vec2(-half_size), offset - 0.5), 0.0, 1.0);
  float square = overlap.x * overlap.y;
  // A circle, scaled up to give off as much light as the square.
  float distance = length(offset);
  float circle = clamp(half_size + 0.5 - distance, 0.0, 1.0) * ${(4 / Math.PI).toFixed(6)};
  float roundness = smoothstep(u_roundSizes.x, u_roundSizes.y, v_size);
  // Large circles fade toward their edge.
  float edge = clamp(distance / max(half_size, 1e-3), 0.0, 1.0);
  float soften = 1.0 - u_edgeSoftness * smoothstep(u_roundSizes.y, u_roundSizes.y * 4.0, v_size) * edge * edge;
  float coverage = mix(square, circle * soften, roundness);
  color = u_weight * coverage * v_light * v_channels;
}`;

// A strip of quads along each body's orbit, one instance per body: trails running back
// in time from the body, or (with u_spanDays below 0) a whole orbit as a ring. Each
// vertex is pushed sideways from the orbit by half the strip's width in pixels.
const STRIP_VERTEX = `#version 300 es
${ORBIT_GLSL}
uniform vec2 u_viewport;
uniform float u_samples;
// Above 0: trails, with length from the orbit's size. Below 0: a whole orbit, as a ring.
uniform float u_spanDays;
uniform float u_fadePower;
// Width as a share of the body's point size, or a fixed width in device pixels if above 0.
uniform float u_widthShare;
uniform float u_fixedWidth;
out float v_fade;
out float v_across;
// Distance in pixels from the body's center along the strip, and the body's radius.
out float v_headDistance;
flat out float v_headRadius;
flat out float v_halfWidth;
flat out float v_strength;
flat out vec4 v_channels;
vec2 toPixels(vec2 plot) {
  return ((plot * u_scale + u_offset) * 0.5 + 0.5) * u_viewport;
}
void main() {
  if (filteredOut()) {
    gl_Position = HIDDEN;
    return;
  }
  float index = float(gl_VertexID / 2);
  float side = gl_VertexID % 2 == 0 ? -1.0 : 1.0;
  float trailDays = clamp(
    ${TRAIL_DAYS_AT_BELT.toFixed(3)} * pow(a_orbit.x / ${TRAIL_BELT_AU.toFixed(3)}, ${TRAIL_DAYS_POWER.toFixed(3)}),
    ${TRAIL_MIN_DAYS.toFixed(3)},
    ${TRAIL_MAX_DAYS.toFixed(3)}
  );
  float span = u_spanDays > 0.0 ? trailDays : TAU / a_orbit.w;
  float spacing = span / (u_samples - 1.0);
  float share = index / (u_samples - 1.0);
  float t = u_time - share * span;
  vec2 here = toPixels(plotPosition(t));
  vec2 tangent = toPixels(plotPosition(t + spacing * 0.5)) - toPixels(plotPosition(t - spacing * 0.5));
  float tangentLength = length(tangent);
  vec2 normal = tangentLength > 1e-5 ? vec2(-tangent.y, tangent.x) / tangentLength : vec2(0.0, 1.0);
  float width = u_fixedWidth > 0.0 ? u_fixedWidth : pointSize() * u_widthShare;
  // Strips thinner than a pixel are drawn a pixel wide and dimmed to match.
  float drawn = max(width, 1.0);
  v_strength = min(width, 1.0);
  v_halfWidth = drawn * 0.5;
  // Half a pixel of margin each side for smooth edges.
  v_across = side * (v_halfWidth + 0.5);
  v_fade = u_fadePower > 0.0 ? pow(1.0 - share, u_fadePower) : 1.0;
  v_headDistance = distance(here, toPixels(plotPosition(u_time)));
  v_headRadius = pointSize() * 0.5;
  v_channels = channels();
  vec2 pixel = here + normal * v_across;
  gl_Position = vec4(pixel / u_viewport * 2.0 - 1.0, 0.0, 1.0);
}`;

const STRIP_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
in float v_fade;
in float v_across;
in float v_headDistance;
flat in float v_headRadius;
uniform float u_clipHead;
flat in float v_halfWidth;
flat in float v_strength;
flat in vec4 v_channels;
out vec4 color;
void main() {
  float coverage = clamp(v_halfWidth + 0.5 - abs(v_across), 0.0, 1.0);
  // Trails start at the edge of their own point.
  if (u_clipHead > 0.5) {
    coverage *= smoothstep(v_headRadius - ${(TRAIL_EDGE_BLEND / 2).toFixed(3)}, v_headRadius + ${(TRAIL_EDGE_BLEND / 2).toFixed(3)}, v_headDistance);
  }
  color = u_weight * v_fade * v_strength * coverage * v_channels;
}`;

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TONE = `
float tone(float density) { return 1.0 - exp(-density); }
// Tones the brightness (alpha) and scales the color channels to match.
vec4 toned(vec4 value) {
  float light = tone(value.a);
  return vec4(value.rgb * (light / max(value.a, 1e-6)), light);
}`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_applyTone;
out vec4 color;
${TONE}
vec4 read(vec2 offset) {
  vec4 value = texture(u_source, v_uv + offset * u_texel);
  return mix(value, toned(value), u_applyTone);
}
void main() {
  vec4 sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0))
           + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = sum * 0.25;
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
out vec4 color;
void main() {
  vec4 sum = texture(u_source, v_uv) * 0.1964825;
  sum += (texture(u_source, v_uv + u_step * 1.4117647)
        + texture(u_source, v_uv - u_step * 1.4117647)) * 0.2969069;
  sum += (texture(u_source, v_uv + u_step * 3.2941176)
        + texture(u_source, v_uv - u_step * 3.2941176)) * 0.0944703;
  sum += (texture(u_source, v_uv + u_step * 5.1764706)
        + texture(u_source, v_uv - u_step * 5.1764706)) * 0.0103814;
  color = sum;
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_density;
uniform sampler2D u_near;
uniform sampler2D u_far;
uniform sampler2D u_trails;
uniform sampler2D u_rings;
uniform float u_nearGlow;
uniform float u_farGlow;
uniform float u_trailStrength;
uniform vec3 u_ringColor;
uniform vec3 u_backgroundCenter;
uniform vec3 u_backgroundEdge;
// The Sun's position and the gradient's radius, in device pixels.
uniform vec2 u_backgroundCenterPixel;
uniform float u_backgroundRadius;
out vec4 color;
${TONE}
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
// The color of some light: its color channels divided by its brightness.
vec3 hue(vec4 value) {
  return clamp(value.rgb / max(value.a, 1e-6), 0.0, 1.0);
}
float noise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 core = toned(texture(u_density, v_uv));
  vec4 near = texture(u_near, v_uv) * u_nearGlow;
  vec4 far = texture(u_far, v_uv) * u_farGlow;
  float light = 1.0 - (1.0 - core.a) * (1.0 - clamp(near.a, 0.0, 1.0)) * (1.0 - clamp(far.a, 0.0, 1.0));
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 tint = hue(core + near + far);
  vec3 ramp[5] = vec3[5](
    vec3(0.0),
    tint * ${DARK_SHADE.toFixed(3)},
    tint,
    mix(tint, vec3(1.0), ${LIGHT_TINT.toFixed(3)}),
    mix(tint, vec3(1.0), ${PEAK_TINT.toFixed(3)})
  );
  float position = clamp(light, 0.0, 1.0) * 4.0;
  int stop = min(int(position), 3);
  vec3 points = mix(ramp[stop], ramp[stop + 1], position - float(stop));

  vec4 trails = texture(u_trails, v_uv);
  vec3 trail = hue(trails) * tone(trails.a) * u_trailStrength;
  vec3 rgb = u_ringColor * tone(texture(u_rings, v_uv).a);
  rgb = screen(rgb, trail);
  rgb = screen(rgb, points);

  // The background: 0 at the Sun, 1 at the gradient's radius, with dithering to avoid banding.
  float reach = distance(gl_FragCoord.xy, u_backgroundCenterPixel) / u_backgroundRadius;
  vec3 background = mix(u_backgroundCenter, u_backgroundEdge, clamp(reach, 0.0, 1.0));
  background += (noise(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
  color = vec4(screen(background, rgb), 1.0);
}`;

// Planet labels: textured quads in device pixels, cut from the label atlas.
const LABEL_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_alpha;
uniform vec2 u_viewport;
out vec2 v_uv;
out float v_alpha;
void main() {
  v_uv = a_uv;
  v_alpha = a_alpha;
  gl_Position = vec4(a_position / u_viewport * 2.0 - 1.0, 0.0, 1.0);
}`;

const LABEL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_alpha;
uniform sampler2D u_atlas;
// Premultiplied.
uniform vec4 u_color;
out vec4 color;
void main() {
  color = u_color * v_alpha * texture(u_atlas, v_uv).a;
}`;

/** Where each planet's name sits in the label atlas, in atlas pixels. */
interface AtlasEntry {
  left: number;
  baseline: number;
  width: number;
  /** Room above and below the baseline for this name's letters. */
  ascent: number;
  descent: number;
}

interface LabelAtlas {
  pixelRatio: number;
  width: number;
  height: number;
  entries: AtlasEntry[];
  /** Clear space around each name. */
  pad: number;
}

// Mirrors plotPosition() in ORBIT_GLSL, for the few bodies placed on the CPU.
const INV_LOG_EDGE = 1 / Math.log(1 + SCALE_EDGE_AU / SCALE_R0_AU);
function plotPositionAt(orbits: Float32Array, index: number, t: number): [number, number] {
  const o = index * FLOATS_PER_ORBIT;
  const [px, py, qx, qy, a, e, m0, n, epoch] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => orbits[o + k]!) as number[];
  const tau = Math.PI * 2;
  const M = (((m0! + n! * (t - epoch!)) % tau) + tau) % tau;
  let E = e! < 0.8 ? M + e! * Math.sin(M) : Math.PI;
  for (let step = 0; step < 12; step += 1) E -= (E - e! * Math.sin(E) - M) / (1 - e! * Math.cos(E));
  const ox = a! * (Math.cos(E) - e!);
  const oy = a! * Math.sqrt(1 - e! * e!) * Math.sin(E);
  const x = ox * px! + oy * qx!;
  const y = ox * py! + oy * qy!;
  const r = Math.max(Math.hypot(x, y), 1e-6);
  const scale = (Math.log(1 + r / SCALE_R0_AU) * INV_LOG_EDGE) / r;
  return [x * scale, y * scale];
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

const glslColor = (hex: string) => `vec3(${hexChannels(hex).map((channel) => channel.toFixed(4)).join(", ")})`;

// A quarter-size copy of the scene's light above the threshold, thresholded per tap so
// small bright points survive.
const BRIGHT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
out vec4 color;
vec3 read(vec2 offset) {
  vec3 value = texture(u_source, v_uv + offset * u_texel).rgb;
  float luminance = dot(value, vec3(0.2126, 0.7152, 0.0722));
  return value * smoothstep(${BRIGHT_THRESHOLD.toFixed(3)}, 1.0, luminance);
}
void main() {
  vec3 sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0)) + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = vec4(sum * 0.25, 1.0);
}`;

// One pass of a long sideways blur that fades away from the center.
const STREAK_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
out vec4 color;
void main() {
  vec3 sum = texture(u_source, v_uv).rgb;
  float total = 1.0;
  for (int tap = 1; tap <= 8; tap += 1) {
    float weight = pow(${STREAK_FALLOFF.toFixed(3)}, float(tap));
    sum += (texture(u_source, v_uv + u_step * float(tap)).rgb + texture(u_source, v_uv - u_step * float(tap)).rgb) * weight;
    total += 2.0 * weight;
  }
  color = vec4(sum / total, 1.0);
}`;

// Keeps the brighter of this frame and the last one, faded.
const PERSIST_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_history;
uniform float u_decay;
out vec4 color;
void main() {
  color = vec4(max(texture(u_scene, v_uv).rgb, texture(u_history, v_uv).rgb * u_decay), 1.0);
}`;

// Every screen effect, drawn to the screen.
const FINAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bright;
uniform sampler2D u_streak;
// Painted UI panels, and where each sits: left, bottom, width and height as shares of the
// screen (zero width when unused).
${Array.from({ length: OVERLAY_COUNT }, (_, slot) => `uniform sampler2D u_overlay${slot};\nuniform vec4 u_overlayRect${slot};`).join("\n")}
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_time;
// The Sun's center and radius, in device pixels.
uniform vec2 u_sunPixel;
uniform float u_sunRadius;
uniform float u_aberration;
uniform float u_scanlines;
uniform float u_curvature;
uniform float u_vignette;
uniform float u_grain;
uniform float u_streaks;
uniform float u_flare;
uniform float u_starburst;
uniform float u_mask;
uniform float u_flicker;
out vec4 color;
const float TAU = 6.28318530718;
const float GHOST_SCALES[${FLARE_GHOSTS.length}] = float[${FLARE_GHOSTS.length}](${FLARE_GHOSTS.map(([scale]) => scale.toFixed(3)).join(", ")});
const vec3 GHOST_TINTS[${FLARE_GHOSTS.length}] = vec3[${FLARE_GHOSTS.length}](${FLARE_GHOSTS.map(([, tint]) => glslColor(tint)).join(", ")});
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// An overlay at a screen position, premultiplied; clear outside its rectangle.
vec4 overlayAt(sampler2D overlay, vec4 rect, vec2 uv) {
  if (rect.z <= 0.0) return vec4(0.0);
  vec2 local = (uv - rect.xy) / rect.zw;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return vec4(0.0);
  return texture(overlay, local);
}
vec3 flare(vec2 uv) {
  vec3 sum = vec3(0.0);
  vec2 fromCenter = uv - 0.5;
  for (int index = 0; index < ${FLARE_GHOSTS.length}; index += 1) {
    vec2 ghost = 0.5 + fromCenter * GHOST_SCALES[index];
    float fade = 1.0 - smoothstep(0.2, 0.7, length(ghost - 0.5));
    sum += texture(u_bright, ghost).rgb * GHOST_TINTS[index] * fade;
  }
  // The halo: a ring sampled toward the center, round on screen whatever its shape.
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 toCenter = (0.5 - uv) * aspect;
  vec2 haloUv = uv + (length(toCenter) > 1e-4 ? normalize(toCenter) : vec2(0.0)) / aspect * ${HALO_RADIUS.toFixed(3)};
  float haloFade = 1.0 - smoothstep(0.3, 0.7, length(haloUv - 0.5));
  sum += texture(u_bright, haloUv).rgb * ${glslColor(HALO_TINT)} * ${HALO_GAIN.toFixed(3)} * haloFade;
  return sum * ${FLARE_GAIN.toFixed(3)};
}
vec3 starburst(vec2 pixel) {
  vec2 offset = pixel - u_sunPixel;
  float total = 0.0;
  for (int index = 0; index < 6; index += 1) {
    // Lines every 30 degrees, starting vertical; every other one is a short, dim spike.
    float angle = 1.5707963 + float(index) * 0.5235988;
    bool isMain = index % 2 == 0;
    vec2 direction = vec2(cos(angle), sin(angle));
    float along = abs(dot(offset, direction));
    float across = abs(offset.x * direction.y - offset.y * direction.x);
    float spikeLength = u_sunRadius * ${SPIKE_LENGTH.toFixed(3)} * (isMain ? 1.0 : 0.45) * (0.4 + 0.6 * u_starburst);
    float width = u_pixelRatio * ${SPIKE_WIDTH.toFixed(3)} * (1.0 - 0.6 * clamp(along / spikeLength, 0.0, 1.0));
    total += (isMain ? 1.0 : 0.5) * exp(-3.0 * along / spikeLength) * exp(-across * across / (2.0 * width * width));
  }
  // Leave the Sun's own disc alone.
  total *= smoothstep(0.7, 1.3, length(offset) / u_sunRadius);
  return ${glslColor(STARBURST_TINT)} * total * u_starburst * ${STARBURST_GAIN.toFixed(3)};
}
void main() {
  // Curvature: the screen bulges, edges bowing out and corners cut off.
  vec2 centered = v_uv * 2.0 - 1.0;
  vec2 curved = centered + centered * (centered.yx * centered.yx) * u_curvature * ${CURVATURE_MAX.toFixed(3)};
  vec2 uv = curved * 0.5 + 0.5;
  vec2 pixel = uv * u_resolution;
  vec2 halfSize = u_resolution * 0.5;
  float radius = u_curvature * ${CORNER_RADIUS.toFixed(1)} * u_pixelRatio;
  vec2 corner = abs(curved) * halfSize - (halfSize - radius);
  float outside = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius;
  float inside = clamp(0.5 - outside, 0.0, 1.0);

  // Chromatic aberration: red and blue pulled apart, more toward the edges.
  vec2 fringe = curved * dot(curved, curved) * u_aberration * ${ABERRATION_MAX.toFixed(4)} * 0.5;
  vec3 rgb = vec3(
    texture(u_scene, uv + fringe).r,
    texture(u_scene, uv).g,
    texture(u_scene, uv - fringe).b
  );
  // The UI panels, laid over the scene with the same fringes.
${Array.from(
  { length: OVERLAY_COUNT },
  (_, slot) => `  {
    vec4 overlayRed = overlayAt(u_overlay${slot}, u_overlayRect${slot}, uv + fringe);
    vec4 overlayGreen = overlayAt(u_overlay${slot}, u_overlayRect${slot}, uv);
    vec4 overlayBlue = overlayAt(u_overlay${slot}, u_overlayRect${slot}, uv - fringe);
    rgb = vec3(
      rgb.r * (1.0 - overlayRed.a) + overlayRed.r,
      rgb.g * (1.0 - overlayGreen.a) + overlayGreen.g,
      rgb.b * (1.0 - overlayBlue.a) + overlayBlue.b
    );
  }`,
).join("\n")}

  if (u_streaks > 0.0) rgb += texture(u_streak, uv).rgb * ${glslColor(STREAK_TINT)} * u_streaks * ${STREAK_GAIN.toFixed(3)};
  if (u_flare > 0.0) rgb += flare(uv) * u_flare;
  if (u_starburst > 0.0) rgb += starburst(pixel);

  // Scanlines, following the curve.
  float line = 0.5 + 0.5 * cos(TAU * pixel.y / (${SCANLINE_PERIOD.toFixed(2)} * u_pixelRatio));
  rgb *= mix(1.0, 1.0 - ${SCANLINE_DEPTH.toFixed(3)} * (1.0 - line), u_scanlines) * (1.0 + u_scanlines * ${(SCANLINE_DEPTH * 0.4).toFixed(3)});

  // Phosphor mask: red, green and blue stripes, brightened to keep the overall level.
  float column = mod(floor(gl_FragCoord.x / max(1.0, floor(u_pixelRatio))), 3.0);
  vec3 stripe = vec3(column < 0.5, column >= 0.5 && column < 1.5, column >= 1.5);
  vec3 mask = mix(vec3(1.0 - ${MASK_DEPTH.toFixed(3)}), vec3(1.0), stripe);
  float maskLevel = 1.0 - ${MASK_DEPTH.toFixed(3)} * 2.0 / 3.0;
  rgb *= mix(vec3(1.0), mask / maskLevel, u_mask);

  // Flicker and a slow bar rolling up the screen.
  float wobble = hash(vec2(floor(u_time * 24.0), 7.0));
  float bar = exp(-pow((fract(v_uv.y - u_time * 0.07) - 0.5) * 7.0, 2.0));
  rgb *= 1.0 - u_flicker * ${FLICKER_MAX.toFixed(3)} * wobble + u_flicker * ${ROLLING_BAR_MAX.toFixed(3)} * bar;

  rgb *= 1.0 - u_vignette * ${VIGNETTE_MAX.toFixed(3)} * smoothstep(0.3, 2.0, dot(curved, curved));
  rgb += (hash(gl_FragCoord.xy + fract(u_time * 7.13) * vec2(431.0, 197.0)) - 0.5) * u_grain * ${GRAIN_MAX.toFixed(3)};
  color = vec4(clamp(rgb, 0.0, 1.0) * inside, 1.0);
}`;

function hexChannels(hex: string): number[] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string, uniformNames: string[]): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { texture, framebuffer, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target) {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

export interface Errors {
  noWebGl: string;
  noFloatRendering: string;
}

const ORBIT_UNIFORMS = [
  "u_scale",
  "u_offset",
  "u_time",
  "u_pointSize",
  "u_decadeSize",
  "u_maxSize",
  "u_sizeScale",
  "u_colors",
  "u_useChannels",
  "u_channels",
  "u_weight",
  "u_useFilter",
  "u_filterA",
  "u_filterLogDiameter",
  "u_filterE",
];

/**
 * Draws the asteroids, planets and Sun at a moment in time. Positions are solved on
 * the GPU from each orbit, so moving time or the camera only changes uniforms. Bodies
 * add their brightness and color into a density buffer that a two-size glow turns
 * into light. Trails and the planets' orbit rings get buffers of their own.
 */
export class OrbitRenderer {
  private gl: WebGL2RenderingContext;
  private resources: Resources | null = null;
  private targets: Targets | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private maxPointSize = 64;
  private time = 0;
  private camera: Camera = { zoom: 1, x: 0, y: 0 };
  private frame = 0;
  private colors: Float32Array;
  private effects: EffectSettings = DEFAULT_EFFECTS;
  // Whether bodies, camera or size changed since the scene was last drawn; screen effects
  // alone can redraw from the stored scene.
  private sceneDirty = true;
  private filter: OrbitFilter = NO_FILTER;
  private atlas: LabelAtlas | null = null;
  private overlays: ({ source: HTMLCanvasElement; rect: { x: number; y: number; width: number; height: number } } | null)[] =
    Array.from({ length: OVERLAY_COUNT }, () => null);

  /**
   * `bodies` holds the planets' orbits then the Sun's, and `colors` is the color
   * table that every body's color index points into (see colors.ts).
   */
  constructor(
    private canvas: HTMLCanvasElement,
    private data: OrbitData,
    private bodies: Float32Array,
    colors: string[],
    private errors: Errors,
  ) {
    if (colors.length > MAX_COLORS) throw new Error(`At most ${MAX_COLORS} colors`);
    this.colors = new Float32Array(MAX_COLORS * 3);
    this.colors.set(colors.flatMap(hexChannels));
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error(errors.noWebGl);
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.createResources();
    void document.fonts.load(`${LABEL_FONT_WEIGHT} ${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`).then(() => {
      this.atlas = null;
      this.sceneDirty = true;
      this.requestDraw();
    });
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }

  /**
   * Where a point on screen shows after the curvature, both in CSS pixels from the plot's
   * top left: the point of the undistorted frame (and UI panels) drawn there. Mirrors the
   * curve in FINAL_FRAGMENT.
   */
  sourcePoint(x: number, y: number) {
    const { width, height } = this;
    if (width === 0 || height === 0) return { x, y };
    const strength = effectAmount(this.effects, "curvature") * CURVATURE_MAX;
    const cx = (x / width) * 2 - 1;
    const cy = (y / height) * 2 - 1;
    return {
      x: ((cx + cx * cy * cy * strength) * 0.5 + 0.5) * width,
      y: ((cy + cy * cx * cx * strength) * 0.5 + 0.5) * height,
    };
  }

  setLayout(width: number, height: number) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.width = width;
    this.height = height;
    const pixelWidth = Math.max(1, Math.round(width * this.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * this.pixelRatio));
    this.sceneDirty = true;
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight || !this.targets) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.createTargets();
    }
    this.requestDraw();
  }

  /** The moment shown, in days from the data's reference epoch. */
  setTime(days: number) {
    this.time = days;
    this.sceneDirty = true;
    this.requestDraw();
  }

  setCamera(camera: Camera) {
    this.camera = camera;
    this.sceneDirty = true;
    this.requestDraw();
  }

  /**
   * Draws a canvas over the scene, before the screen effects, so it looks like part of
   * the display. `rect` is in CSS pixels from the canvas's top left. Call again whenever
   * the canvas changes. Each panel has its own `slot`, below OVERLAY_COUNT.
   */
  setOverlay(slot: number, source: HTMLCanvasElement, rect: { x: number; y: number; width: number; height: number }) {
    this.overlays[slot] = { source, rect };
    this.uploadOverlay(slot, source);
    this.requestDraw();
  }

  private uploadOverlay(slot: number, source: HTMLCanvasElement) {
    const { gl, resources } = this;
    if (!resources) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.overlays[slot]!);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Shows only the asteroids within the filter's ranges. */
  setFilter(filter: OrbitFilter) {
    this.filter = filter;
    this.sceneDirty = true;
    this.requestDraw();
  }

  setEffects(effects: EffectSettings) {
    this.effects = effects;
    // Flares and streaks are only prepared while on, so turning one on needs a fresh scene.
    this.sceneDirty = true;
    this.requestDraw();
  }

  // Grain, flicker and persistence change every frame, so they keep drawing.
  private isAnimated() {
    const { effects } = this;
    return (
      effectAmount(effects, "grain") > 0 || effectAmount(effects, "flicker") > 0 || effectAmount(effects, "persistence") > 0
    );
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resources = null;
    this.targets = null;
  };

  private onContextRestored = () => {
    this.sceneDirty = true;
    this.createResources();
    this.createTargets();
    this.requestDraw();
  };

  private createResources() {
    const { gl } = this;
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error(this.errors.noFloatRendering);
    const sizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.maxPointSize = sizeRange?.[1] ?? 64;

    const stride = FLOATS_PER_ORBIT * 4;
    // Points read one orbit per vertex (divisor 0); strips one orbit per instance (divisor 1).
    const orbitVaos = (orbits: Float32Array) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, orbits, gl.STATIC_DRAW);
      const [points, strips] = [0, 1].map((divisor) => {
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const layout: [number, number, number][] = [
          [0, 4, 0],
          [1, 4, 16],
          [2, 3, 32],
        ];
        for (const [location, size, offset] of layout) {
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
          gl.vertexAttribDivisor(location, divisor);
        }
        gl.bindVertexArray(null);
        return vao;
      });
      return [points!, strips!] as const;
    };
    const [asteroidPoints, asteroidStrips] = orbitVaos(this.data.orbits);
    const [bodyPoints, bodyStrips] = orbitVaos(this.bodies);

    // Label vertices: x, y in device pixels, u, v in the atlas, then opacity; rewritten every frame.
    const labelBuffer = gl.createBuffer()!;
    const labelVao = gl.createVertexArray()!;
    gl.bindVertexArray(labelVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, labelBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
    const labelAtlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, labelAtlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlas = null;

    this.resources = {
      labels: createProgram(gl, LABEL_VERTEX, LABEL_FRAGMENT, ["u_viewport", "u_atlas", "u_color"]),
      labelVao,
      labelBuffer,
      labelAtlas,
      points: createProgram(gl, POINT_VERTEX, POINT_FRAGMENT, [
        ...ORBIT_UNIFORMS,
        "u_lightSize",
        "u_lightSpread",
        "u_edgeSoftness",
        "u_roundSizes",
      ]),
      strips: createProgram(gl, STRIP_VERTEX, STRIP_FRAGMENT, [
        ...ORBIT_UNIFORMS,
        "u_viewport",
        "u_samples",
        "u_spanDays",
        "u_fadePower",
        "u_widthShare",
        "u_fixedWidth",
        "u_clipHead",
      ]),
      downsample: createProgram(gl, FULLSCREEN_VERTEX, DOWNSAMPLE_FRAGMENT, ["u_source", "u_texel", "u_applyTone"]),
      blur: createProgram(gl, FULLSCREEN_VERTEX, BLUR_FRAGMENT, ["u_source", "u_step"]),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT, [
        "u_density",
        "u_near",
        "u_far",
        "u_trails",
        "u_rings",
        "u_nearGlow",
        "u_farGlow",
        "u_trailStrength",
        "u_ringColor",
        "u_backgroundCenter",
        "u_backgroundEdge",
        "u_backgroundCenterPixel",
        "u_backgroundRadius",
      ]),
      bright: createProgram(gl, FULLSCREEN_VERTEX, BRIGHT_FRAGMENT, ["u_source", "u_texel"]),
      streak: createProgram(gl, FULLSCREEN_VERTEX, STREAK_FRAGMENT, ["u_source", "u_step"]),
      persist: createProgram(gl, FULLSCREEN_VERTEX, PERSIST_FRAGMENT, ["u_scene", "u_history", "u_decay"]),
      final: createProgram(gl, FULLSCREEN_VERTEX, FINAL_FRAGMENT, [
        "u_scene",
        "u_bright",
        "u_streak",
        ...Array.from({ length: OVERLAY_COUNT }, (_, slot) => [`u_overlay${slot}`, `u_overlayRect${slot}`]).flat(),
        "u_resolution",
        "u_pixelRatio",
        "u_time",
        "u_sunPixel",
        "u_sunRadius",
        "u_aberration",
        "u_scanlines",
        "u_curvature",
        "u_vignette",
        "u_grain",
        "u_streaks",
        "u_flare",
        "u_starburst",
        "u_mask",
        "u_flicker",
      ]),
      asteroidPoints,
      asteroidStrips,
      bodyPoints,
      bodyStrips,
      emptyVao: gl.createVertexArray()!,
      overlays: Array.from({ length: OVERLAY_COUNT }, () => gl.createTexture()!),
    };
    this.resources.overlays.forEach((texture, slot) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const overlay = this.overlays[slot];
      if (overlay) this.uploadOverlay(slot, overlay.source);
    });
  }

  private createTargets() {
    const { gl, canvas } = this;
    if (this.targets) for (const target of Object.values(this.targets)) deleteTarget(gl, target);
    const size = (divisor: number) =>
      [Math.max(1, Math.ceil(canvas.width / divisor)), Math.max(1, Math.ceil(canvas.height / divisor))] as const;
    this.targets = {
      density: createTarget(gl, canvas.width, canvas.height),
      trails: createTarget(gl, canvas.width, canvas.height),
      rings: createTarget(gl, canvas.width, canvas.height),
      nearA: createTarget(gl, ...size(4)),
      nearB: createTarget(gl, ...size(4)),
      farA: createTarget(gl, ...size(16)),
      farB: createTarget(gl, ...size(16)),
      scene: createTarget(gl, canvas.width, canvas.height),
      historyA: createTarget(gl, canvas.width, canvas.height),
      historyB: createTarget(gl, canvas.width, canvas.height),
      brightA: createTarget(gl, ...size(4)),
      brightB: createTarget(gl, ...size(4)),
      streakA: createTarget(gl, ...size(4)),
      streakB: createTarget(gl, ...size(4)),
    };
    this.sceneDirty = true;
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      if (this.isAnimated()) this.requestDraw();
    });
  }

  /** Plot units to clip space: clip = plot * scale + offset. */
  private projection() {
    const { zoom, x, y } = this.camera;
    const pixelsPerUnit = (Math.min(this.width, this.height) / 2) * PLOT_FILL * zoom;
    const scaleX = (2 * pixelsPerUnit) / this.width;
    const scaleY = (2 * pixelsPerUnit) / this.height;
    return { scaleX, scaleY, offsetX: -x * scaleX, offsetY: -y * scaleY };
  }

  /** Sets the uniforms both orbit programs share. `channels` overrides the group colors. */
  private setOrbitUniforms(
    program: Program,
    weight: number,
    sizeScale: number,
    channels: number[] | null,
    filtered: boolean,
  ) {
    const { gl, pixelRatio } = this;
    const { scaleX, scaleY, offsetX, offsetY } = this.projection();
    const growth = zoomGrowth(this.camera.zoom);
    const { uniforms } = program;
    gl.useProgram(program.program);
    gl.uniform2f(uniforms.u_scale!, scaleX, scaleY);
    gl.uniform2f(uniforms.u_offset!, offsetX, offsetY);
    gl.uniform1f(uniforms.u_time!, this.time);
    gl.uniform1f(uniforms.u_pointSize!, Math.max(0.5, POINT_SIZE * growth * pixelRatio));
    gl.uniform1f(uniforms.u_decadeSize!, SIZE_PER_DECADE * growth * pixelRatio);
    gl.uniform1f(uniforms.u_maxSize!, this.maxPointSize - 1);
    gl.uniform1f(uniforms.u_sizeScale!, sizeScale);
    gl.uniform3fv(uniforms.u_colors!, this.colors);
    gl.uniform1f(uniforms.u_useChannels!, channels ? 1 : 0);
    const [r, g, b, a] = channels ?? [0, 0, 0, 0];
    gl.uniform4f(uniforms.u_channels!, r!, g!, b!, a!);
    gl.uniform1f(uniforms.u_weight!, weight);
    const { filter } = this;
    gl.uniform1f(uniforms.u_useFilter!, filtered ? 1 : 0);
    gl.uniform2f(uniforms.u_filterA!, filter.a[0], filter.a[1]);
    gl.uniform2f(uniforms.u_filterLogDiameter!, filter.logDiameter[0], filter.logDiameter[1]);
    gl.uniform2f(uniforms.u_filterE!, filter.e[0], filter.e[1]);
  }

  private drawPoints(
    vao: WebGLVertexArrayObject,
    first: number,
    count: number,
    weight: number,
    sizeScale: number,
    look: { lightSpread: number; edgeSoftness: number },
    channels: number[] | null,
  ) {
    const { gl, resources, pixelRatio } = this;
    if (!resources) return;
    const { points } = resources;
    // Only the asteroids are filtered.
    this.setOrbitUniforms(points, weight, sizeScale, channels, vao === resources.asteroidPoints);
    const growth = zoomGrowth(this.camera.zoom);
    gl.uniform1f(points.uniforms.u_lightSize!, Math.max(0.5, LIGHT_BASE_SIZE * growth * pixelRatio));
    gl.uniform1f(points.uniforms.u_lightSpread!, look.lightSpread);
    gl.uniform1f(points.uniforms.u_edgeSoftness!, look.edgeSoftness);
    gl.uniform2f(points.uniforms.u_roundSizes!, ROUND_POINT_SIZES[0]!, ROUND_POINT_SIZES[1]!);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.POINTS, first, count);
  }

  private drawStrips(
    vao: WebGLVertexArrayObject,
    count: number,
    weight: number,
    sizeScale: number,
    strip: { samples: number; spanDays: number; fadePower: number; widthShare: number; fixedWidth: number },
    channels: number[] | null,
  ) {
    const { gl, resources } = this;
    if (!resources) return;
    const { strips } = resources;
    this.setOrbitUniforms(strips, weight, sizeScale, channels, vao === resources.asteroidStrips);
    gl.uniform1f(strips.uniforms.u_clipHead!, strip.spanDays > 0 ? 1 : 0);
    const { uniforms } = strips;
    gl.uniform2f(uniforms.u_viewport!, this.canvas.width, this.canvas.height);
    gl.uniform1f(uniforms.u_samples!, strip.samples);
    gl.uniform1f(uniforms.u_spanDays!, strip.spanDays);
    gl.uniform1f(uniforms.u_fadePower!, strip.fadePower);
    gl.uniform1f(uniforms.u_widthShare!, strip.widthShare);
    gl.uniform1f(uniforms.u_fixedWidth!, strip.fixedWidth);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, strip.samples * 2, count);
  }

  private draw() {
    const { resources, targets } = this;
    if (!resources || !targets) return;
    if (this.sceneDirty) {
      this.drawScene(resources, targets);
      this.drawLabels(resources, targets);
      this.drawBright(resources, targets);
      this.sceneDirty = false;
    }
    this.drawEffects(resources, targets);
  }

  /** Draws a fullscreen pass into a target, or the screen. */
  private pass(target: Target | null) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Binds targets' textures to units in order, for a program's samplers. */
  private bindTextures(program: Program, textures: [string, Target][]) {
    const { gl } = this;
    gl.useProgram(program.program);
    textures.forEach(([name, target], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.uniform1i(program.uniforms[name]!, unit);
    });
    gl.activeTexture(gl.TEXTURE0);
  }

  private drawScene(resources: Resources, targets: Targets) {
    const { gl, pixelRatio } = this;
    // The body buffer holds the planets, then the Sun.
    const planetCount = PLANETS.length;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Trails, for asteroids and planets alike.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.trails.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const trail = {
      samples: TRAIL_SAMPLES,
      spanDays: 1,
      fadePower: TRAIL_FADE_POWER,
      widthShare: TRAIL_WIDTH_SHARE,
      fixedWidth: 0,
    };
    this.drawStrips(resources.asteroidStrips, this.data.count, TRAIL_WEIGHT, 1, trail, null);
    this.drawStrips(resources.bodyStrips, planetCount, TRAIL_WEIGHT, PLANET_SIZE_BOOST, trail, null);

    // Points: asteroids, then the planets, then the Sun.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.density.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const zoomBoost = 1 + ZOOM_BRIGHTNESS * Math.log2(this.camera.zoom);
    this.drawPoints(resources.asteroidPoints, 0, this.data.count, POINT_WEIGHT * zoomBoost, 1, ASTEROID_LOOK, null);
    this.drawPoints(resources.bodyPoints, 0, planetCount, PLANET_WEIGHT * zoomBoost, PLANET_SIZE_BOOST, PLANET_LOOK, null);
    this.drawPoints(resources.bodyPoints, planetCount, 1, SUN_WEIGHT, SUN_SIZE_BOOST, SUN_LOOK, null);

    // The planets' orbit rings.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.rings.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawStrips(
      resources.bodyStrips,
      planetCount,
      1,
      1,
      { samples: RING_SAMPLES, spanDays: -1, fadePower: 0, widthShare: 0, fixedWidth: RING_WIDTH * pixelRatio },
      [1, 1, 1, 1],
    );

    gl.disable(gl.BLEND);
    this.drawGlow(resources, targets);
  }

  private drawGlow(resources: Resources, targets: Targets) {
    const { gl } = this;
    const { downsample, blur, composite, emptyVao } = resources;
    gl.bindVertexArray(emptyVao);
    gl.activeTexture(gl.TEXTURE0);

    const pass = (target: Target) => this.pass(target);
    const shrink = (source: Target, target: Target, applyTone: number) => {
      gl.useProgram(downsample.program);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(downsample.uniforms.u_source!, 0);
      gl.uniform2f(downsample.uniforms.u_texel!, 1 / source.width, 1 / source.height);
      gl.uniform1f(downsample.uniforms.u_applyTone!, applyTone);
      pass(target);
    };
    const soften = (main: Target, spare: Target) => {
      gl.useProgram(blur.program);
      gl.uniform1i(blur.uniforms.u_source!, 0);
      gl.bindTexture(gl.TEXTURE_2D, main.texture);
      gl.uniform2f(blur.uniforms.u_step!, 1 / main.width, 0);
      pass(spare);
      gl.bindTexture(gl.TEXTURE_2D, spare.texture);
      gl.uniform2f(blur.uniforms.u_step!, 0, 1 / main.height);
      pass(main);
    };

    shrink(targets.density, targets.nearA, 1);
    shrink(targets.nearA, targets.farA, 0);
    soften(targets.nearA, targets.nearB);
    soften(targets.farA, targets.farB);

    this.bindTextures(composite, [
      ["u_density", targets.density],
      ["u_near", targets.nearA],
      ["u_far", targets.farA],
      ["u_trails", targets.trails],
      ["u_rings", targets.rings],
    ]);
    const { uniforms } = composite;
    gl.uniform1f(uniforms.u_nearGlow!, NEAR_GLOW);
    gl.uniform1f(uniforms.u_farGlow!, FAR_GLOW);
    gl.uniform1f(uniforms.u_trailStrength!, TRAIL_STRENGTH);
    gl.uniform3f(uniforms.u_ringColor!, RING_GRAY, RING_GRAY, RING_GRAY);
    gl.uniform3fv(uniforms.u_backgroundCenter!, hexChannels(BACKGROUND_CENTER));
    gl.uniform3fv(uniforms.u_backgroundEdge!, hexChannels(BACKGROUND_EDGE));
    // The Sun is the plot's origin, at clip position (offsetX, offsetY).
    const { offsetX, offsetY } = this.projection();
    const { width, height } = this.canvas;
    gl.uniform2f(uniforms.u_backgroundCenterPixel!, ((offsetX + 1) / 2) * width, ((offsetY + 1) / 2) * height);
    gl.uniform1f(uniforms.u_backgroundRadius!, Math.hypot(width / 2, height / 2) * this.camera.zoom);
    pass(targets.scene);
  }

  /** The scene's bright parts at a quarter size: streaked sideways, and blurred for flares. */
  private drawBright(resources: Resources, targets: Targets) {
    const { gl, effects } = this;
    if (effectAmount(effects, "streaks") === 0 && effectAmount(effects, "flare") === 0) return;
    const { bright, streak, blur, emptyVao } = resources;
    gl.bindVertexArray(emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(bright.program);
    gl.bindTexture(gl.TEXTURE_2D, targets.scene.texture);
    gl.uniform1i(bright.uniforms.u_source!, 0);
    gl.uniform2f(bright.uniforms.u_texel!, 1 / targets.scene.width, 1 / targets.scene.height);
    this.pass(targets.brightA);

    // Streaks: each pass reaches further, ending in streakA.
    gl.useProgram(streak.program);
    gl.uniform1i(streak.uniforms.u_source!, 0);
    let source = targets.brightA;
    STREAK_STEPS.forEach((step, index) => {
      const target = index % 2 === 0 ? targets.streakA : targets.streakB;
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(streak.uniforms.u_step!, step / source.width, 0);
      this.pass(target);
      source = target;
    });
    if (source !== targets.streakA) {
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(streak.uniforms.u_step!, 0, 0);
      this.pass(targets.streakA);
    }

    // The flare source: brightA, blurred in place.
    gl.useProgram(blur.program);
    gl.uniform1i(blur.uniforms.u_source!, 0);
    const blurPasses: [Target, Target, number, number][] = [
      [targets.brightA, targets.brightB, 1, 0],
      [targets.brightB, targets.brightA, 0, 1],
    ];
    for (const [from, to, x, y] of blurPasses) {
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(blur.uniforms.u_step!, (x * 2) / from.width, (y * 2) / from.height);
      this.pass(to);
    }
  }

  /** Persistence, then every other screen effect, to the screen. */
  private drawEffects(resources: Resources, targets: Targets) {
    const { gl, effects, pixelRatio } = this;
    const { persist, final, emptyVao } = resources;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVao);

    let scene = targets.scene;
    const persistence = effectAmount(effects, "persistence");
    if (persistence > 0) {
      this.bindTextures(persist, [
        ["u_scene", targets.scene],
        ["u_history", targets.historyA],
      ]);
      const [weakest, strongest] = PERSISTENCE_RANGE as [number, number];
      gl.uniform1f(persist.uniforms.u_decay!, weakest + (strongest - weakest) * persistence);
      this.pass(targets.historyB);
      [targets.historyA, targets.historyB] = [targets.historyB, targets.historyA];
      scene = targets.historyA;
    }

    this.bindTextures(final, [
      ["u_scene", scene],
      ["u_bright", targets.brightA],
      ["u_streak", targets.streakA],
    ]);
    const { uniforms } = final;
    // Overlays take the texture units after the three bound above.
    resources.overlays.forEach((texture, slot) => {
      gl.activeTexture(gl.TEXTURE3 + slot);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms[`u_overlay${slot}`]!, 3 + slot);
      const rect = this.overlays[slot]?.rect;
      gl.uniform4f(
        uniforms[`u_overlayRect${slot}`]!,
        rect ? rect.x / this.width : 0,
        rect ? 1 - (rect.y + rect.height) / this.height : 0,
        rect ? rect.width / this.width : 0,
        rect ? rect.height / this.height : 0,
      );
    });
    gl.activeTexture(gl.TEXTURE0);
    const { width, height } = this.canvas;
    gl.uniform2f(uniforms.u_resolution!, width, height);
    gl.uniform1f(uniforms.u_pixelRatio!, pixelRatio);
    gl.uniform1f(uniforms.u_time!, (performance.now() / 1000) % 1000);
    const { offsetX, offsetY } = this.projection();
    gl.uniform2f(uniforms.u_sunPixel!, ((offsetX + 1) / 2) * width, ((offsetY + 1) / 2) * height);
    gl.uniform1f(uniforms.u_sunRadius!, this.sunSize() / 2);
    const amounts: [string, number][] = [
      ["u_aberration", effectAmount(effects, "chromaticAberration")],
      ["u_scanlines", effectAmount(effects, "scanlines")],
      ["u_curvature", effectAmount(effects, "curvature")],
      ["u_vignette", effectAmount(effects, "vignette")],
      ["u_grain", effectAmount(effects, "grain")],
      ["u_streaks", effectAmount(effects, "streaks")],
      ["u_flare", effectAmount(effects, "flare")],
      ["u_starburst", effectAmount(effects, "starburst")],
      ["u_mask", effectAmount(effects, "phosphorMask")],
      ["u_flicker", effectAmount(effects, "flicker")],
    ];
    for (const [name, amount] of amounts) gl.uniform1f(uniforms[name]!, amount);
    this.pass(null);
  }

  /** A body's width in device pixels, matching the point shader's sizing. */
  private bodySize(orbits: Float32Array, index: number, boost: number) {
    const growth = zoomGrowth(this.camera.zoom);
    const logDiameter = orbits[index * FLOATS_PER_ORBIT + 9]!;
    const base = Math.max(0.5, POINT_SIZE * growth * this.pixelRatio);
    const decades = Math.max(logDiameter - Math.log10(MIN_DIAMETER_KM), 0);
    return Math.min((base + SIZE_PER_DECADE * growth * this.pixelRatio * decades) * boost, this.maxPointSize - 1);
  }

  private sunSize() {
    return this.bodySize(this.bodies, PLANETS.length, SUN_SIZE_BOOST);
  }

  /** Renders every label's name (planets, then asteroids), white on clear, for the label quads to cut from. */
  private buildAtlas(texture: WebGLTexture): LabelAtlas {
    const { gl, pixelRatio } = this;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    // Planets, then asteroids, each with its text scale.
    const labels: [string, number][] = [
      ...PLANETS.map((planet): [string, number] => [planet.name, PLANET_LABEL_SCALE]),
      ...this.data.meta.labels.map((label): [string, number] => [label.name, 1]),
    ];
    const fontFor = (scale: number) =>
      `${LABEL_FONT_WEIGHT} ${LABEL_FONT_SIZE * scale * pixelRatio}px ${LABEL_FONT_FAMILY}`;
    const layout = labels.map(([rawName, scale]) => {
      const name = rawName.toUpperCase();
      const spacing = LABEL_LETTER_SPACING * scale * pixelRatio;
      context.font = fontFor(scale);
      const metrics = context.measureText(name);
      const width =
        [...name].reduce((sum, character) => sum + context.measureText(character).width, 0) + spacing * (name.length - 1);
      return {
        name,
        scale,
        spacing,
        width,
        ascent: Math.ceil(metrics.actualBoundingBoxAscent),
        descent: Math.ceil(metrics.actualBoundingBoxDescent),
      };
    });
    const pad = Math.ceil(2 * pixelRatio);
    // A solid block at the top left for the leader lines, then one row per name.
    const block = 4;
    canvas.width = Math.ceil(Math.max(...layout.map((row) => row.width), block)) + pad * 2;
    canvas.height = block + layout.reduce((sum, row) => sum + row.ascent + row.descent + pad * 2, 0);
    context.fillStyle = "#fff";
    context.textBaseline = "alphabetic";
    context.fillRect(0, 0, block, block);
    let rowTop = block;
    const entries = layout.map((row) => {
      const baseline = rowTop + pad + row.ascent;
      rowTop += row.ascent + row.descent + pad * 2;
      context.font = fontFor(row.scale);
      let x = pad;
      for (const character of row.name) {
        context.fillText(character, x, baseline);
        x += context.measureText(character).width + row.spacing;
      }
      return { left: pad, baseline, width: row.width, ascent: row.ascent, descent: row.descent };
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return { pixelRatio, width: canvas.width, height: canvas.height, entries, pad };
  }

  /**
   * Each planet's name, and the largest named asteroids', on a leader line pointing away
   * from the Sun, written along its orbit. Text is turned half around on the Sun's lower side so it's never upside down.
   * Drawn into the scene, so the screen effects apply.
   */
  private drawLabels(resources: Resources, targets: Targets) {
    const { gl, pixelRatio } = this;
    const planetFade = smoothstep(LABEL_ZOOM[0]!, LABEL_ZOOM[1]!, this.camera.zoom);
    const asteroidFade = smoothstep(ASTEROID_LABEL_ZOOM[0]!, ASTEROID_LABEL_ZOOM[1]!, this.camera.zoom);
    if (planetFade <= 0 && asteroidFade <= 0) return;
    if (!this.atlas || this.atlas.pixelRatio !== pixelRatio) this.atlas = this.buildAtlas(resources.labelAtlas);
    const atlas = this.atlas;
    const { width, height } = this.canvas;
    const { scaleX, scaleY, offsetX, offsetY } = this.projection();
    const toPixels = ([x, y]: [number, number]): [number, number] => [
      ((x * scaleX + offsetX + 1) / 2) * width,
      ((y * scaleY + offsetY + 1) / 2) * height,
    ];
    const sun = toPixels([0, 0]);
    const vertices: number[] = [];
    let alpha = 1;
    // Two triangles from a corner and two edge vectors, with matching atlas corners.
    const quad = (
      origin: [number, number],
      across: [number, number],
      up: [number, number],
      uv0: [number, number],
      uv1: [number, number],
    ) => {
      const corner = (a: number, b: number) => [
        origin[0] + across[0] * a + up[0] * b,
        origin[1] + across[1] * a + up[1] * b,
        uv0[0] + (uv1[0] - uv0[0]) * a,
        uv0[1] + (uv1[1] - uv0[1]) * b,
        alpha,
      ];
      vertices.push(...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 0), ...corner(1, 1), ...corner(0, 1));
    };
    const solid: [number, number] = [2 / atlas.width, 2 / atlas.height];

    // Each label: its body's orbits and index, size boost, atlas entry and opacity.
    const labelled: [Float32Array, number, number, number, number][] = [
      ...PLANETS.map((_, index): [Float32Array, number, number, number, number] => [
        this.bodies,
        index,
        PLANET_SIZE_BOOST,
        index,
        planetFade,
      ]),
      ...this.data.meta.labels.map(({ index }, k): [Float32Array, number, number, number, number] => [
        this.data.orbits,
        index,
        1,
        PLANETS.length + k,
        asteroidFade,
      ]),
    ];
    for (const [orbits, index, boost, entryIndex, fade] of labelled) {
      if (fade <= 0) continue;
      if (orbits === this.data.orbits && !passesFilter(orbits, index, this.filter)) continue;
      alpha = fade;
      const entry = atlas.entries[entryIndex]!;
      const position = toPixels(plotPositionAt(orbits, index, this.time));
      const period = (2 * Math.PI) / orbits[index * FLOATS_PER_ORBIT + 7]!;
      const ahead = toPixels(plotPositionAt(orbits, index, this.time + period / 720));
      const behind = toPixels(plotPositionAt(orbits, index, this.time - period / 720));
      const motionLength = Math.hypot(ahead[0] - behind[0], ahead[1] - behind[1]) || 1;
      // Outward: across the orbit, on the side away from the Sun.
      let out: [number, number] = [-(ahead[1] - behind[1]) / motionLength, (ahead[0] - behind[0]) / motionLength];
      if (out[0] * (position[0] - sun[0]) + out[1] * (position[1] - sun[1]) < 0) out = [-out[0], -out[1]];
      // Reading direction, a quarter turn clockwise from outward.
      const along: [number, number] = [out[1], -out[0]];
      const radius = this.bodySize(orbits, index, boost) / 2;
      const px = (cssPixels: number) => cssPixels * pixelRatio;
      const point = (alongDistance: number, outDistance: number): [number, number] => [
        position[0] + along[0] * alongDistance + out[0] * outDistance,
        position[1] + along[1] * alongDistance + out[1] * outDistance,
      ];
      // A line of the label's width between two points.
      const line = (from: [number, number], to: [number, number]) => {
        const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
        const half = px(LABEL_LINE_WIDTH) / 2;
        const side: [number, number] = [(-(to[1] - from[1]) / length) * half, ((to[0] - from[0]) / length) * half];
        quad([from[0] - side[0], from[1] - side[1]], [to[0] - from[0], to[1] - from[1]], [side[0] * 2, side[1] * 2], solid, solid);
      };
      const elbowOut = radius + px(LABEL_GAP + LABEL_LEADER);
      const textStart = px(LABEL_TEXT_INSET);
      const textEnd = textStart + entry.width;
      line(point(0, radius + px(LABEL_GAP)), point(0, elbowOut));
      // The underline runs back along the trail; extended by half a line so the corner is square.
      line(point(-px(LABEL_LINE_WIDTH) / 2, elbowOut), point(textEnd + px(LABEL_UNDERLINE_TAIL), elbowOut));

      // The name sits on the underline. On the Sun's lower side (outward pointing down the
      // screen) it turns half around so it's never upside down, sitting on the line's inner
      // side and still covering the same stretch of it.
      const flipped = out[1] < 0;
      const xAxis: [number, number] = flipped ? [-along[0], -along[1]] : along;
      const yAxis: [number, number] = flipped ? [-out[0], -out[1]] : out;
      const baseline = flipped
        ? point(textEnd, elbowOut - px(LABEL_TEXT_LIFT))
        : point(textStart, elbowOut + px(LABEL_TEXT_LIFT));
      const left = -atlas.pad;
      const right = entry.width + atlas.pad;
      const bottom = -(entry.descent + atlas.pad);
      const top = entry.ascent + atlas.pad;
      quad(
        [baseline[0] + xAxis[0] * left + yAxis[0] * bottom, baseline[1] + xAxis[1] * left + yAxis[1] * bottom],
        [xAxis[0] * (right - left), xAxis[1] * (right - left)],
        [yAxis[0] * (top - bottom), yAxis[1] * (top - bottom)],
        [(entry.left + left) / atlas.width, (entry.baseline - bottom) / atlas.height],
        [(entry.left + right) / atlas.width, (entry.baseline - top) / atlas.height],
      );
    }

    const { labels, labelVao, labelBuffer, labelAtlas } = resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.scene.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(labels.program);
    gl.uniform2f(labels.uniforms.u_viewport!, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, labelAtlas);
    gl.uniform1i(labels.uniforms.u_atlas!, 0);
    const [r, g, b] = hexChannels(LABEL_COLOR);
    gl.uniform4f(labels.uniforms.u_color!, r! * LABEL_OPACITY, g! * LABEL_OPACITY, b! * LABEL_OPACITY, LABEL_OPACITY);
    gl.bindVertexArray(labelVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, labelBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 5);
    gl.disable(gl.BLEND);
  }
}
