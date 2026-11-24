import { FLOATS_PER_ORBIT, type OrbitData } from "./data";
import { PLANETS } from "./planets";

/** The view: `x` and `y` are the plot position at the screen's center, `zoom` 1 shows the whole plot. */
export interface Camera {
  zoom: number;
  x: number;
  y: number;
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
  asteroidPoints: WebGLVertexArrayObject;
  asteroidStrips: WebGLVertexArrayObject;
  /** The planets, then the Sun. */
  bodyPoints: WebGLVertexArrayObject;
  bodyStrips: WebGLVertexArrayObject;
  emptyVao: WebGLVertexArrayObject;
}

interface Targets {
  density: Target;
  trails: Target;
  rings: Target;
  nearA: Target;
  nearB: Target;
  farA: Target;
  farB: Target;
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
const MAX_PIXEL_RATIO = 2;

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
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }

  setLayout(width: number, height: number) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.width = width;
    this.height = height;
    const pixelWidth = Math.max(1, Math.round(width * this.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * this.pixelRatio));
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
    this.requestDraw();
  }

  setCamera(camera: Camera) {
    this.camera = camera;
    this.requestDraw();
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resources = null;
    this.targets = null;
  };

  private onContextRestored = () => {
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

    this.resources = {
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
      asteroidPoints,
      asteroidStrips,
      bodyPoints,
      bodyStrips,
      emptyVao: gl.createVertexArray()!,
    };
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
    };
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
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
  private setOrbitUniforms(program: Program, weight: number, sizeScale: number, channels: number[] | null) {
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
    this.setOrbitUniforms(points, weight, sizeScale, channels);
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
    this.setOrbitUniforms(strips, weight, sizeScale, channels);
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
    const { gl, resources, targets, pixelRatio } = this;
    if (!resources || !targets) return;
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

    const pass = (target: Target | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
      gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
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

    gl.useProgram(composite.program);
    const textures: [string, Target][] = [
      ["u_density", targets.density],
      ["u_near", targets.nearA],
      ["u_far", targets.farA],
      ["u_trails", targets.trails],
      ["u_rings", targets.rings],
    ];
    textures.forEach(([name, target], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.uniform1i(composite.uniforms[name]!, unit);
    });
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
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
