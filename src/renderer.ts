import { FLOATS_PER_ORBIT, type OrbitData } from "./data";

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
  trails: Program;
  downsample: Program;
  blur: Program;
  composite: Program;
  pointsVao: WebGLVertexArrayObject;
  trailsVao: WebGLVertexArrayObject;
  emptyVao: WebGLVertexArrayObject;
}

interface Targets {
  density: Target;
  trails: Target;
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

// ---- Points ------------------------------------------------------------------------
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
// Brightness one point adds to the density buffer.
const POINT_WEIGHT = 0.32;
export const MAX_ZOOM = 64;
// Points grow with zoom, reaching this multiple of their size at the closest zoom.
const MAX_ZOOM_GROWTH = 3;
// Added to a point's brightness for each doubling of zoom.
const ZOOM_BRIGHTNESS = 0.35;
const MAX_PIXEL_RATIO = 2;

// ---- Trails ------------------------------------------------------------------------
/** How far back in time each trail reaches, in days. */
export const TRAIL_DAYS = 60;
// Vertices along each trail.
const TRAIL_SAMPLES = 24;
// Brightness of a trail at its head, before toning.
const TRAIL_WEIGHT = 0.22;
// Trails fade toward their tail by their remaining share to this power.
const TRAIL_FADE_POWER = 1.6;
// The trail layer's color at full strength: pale and cool.
const TRAIL_COLOR = "#a9b8cc";
const TRAIL_STRENGTH = 0.55;

// ---- Glow and color ----------------------------------------------------------------
const NEAR_GLOW = 0.3;
const FAR_GLOW = 0.75;
// Point colors from the sparsest to the densest areas, evenly spaced after black.
export const GRADIENT = ["#0b2a66", "#2c6cf0", "#7fb4ff", "#eef6ff"];
// The Sun, drawn on top: its radius in CSS pixels and its glow's reach.
const SUN_RADIUS = 3.5;
const SUN_GLOW_RADIUS = 22;
const SUN_COLOR = "#fff3d6";

const zoomGrowth = (zoom: number) =>
  Math.min(zoom ** (Math.log(MAX_ZOOM_GROWTH) / Math.log(MAX_ZOOM)), MAX_ZOOM_GROWTH);

// Shared by both orbit programs: per-asteroid attributes and the Kepler solve.
const ORBIT_GLSL = `
layout(location = 0) in vec4 a_frame;   // P.xy, Q.xy: the orbit's axes seen from above
layout(location = 1) in vec4 a_orbit;   // a (AU), e, mean anomaly at epoch (rad), mean motion (rad/day)
layout(location = 2) in vec2 a_extra;   // epoch (days from the reference), log10 diameter
uniform vec2 u_scale;
uniform vec2 u_offset;
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
}`;

const POINT_VERTEX = `#version 300 es
${ORBIT_GLSL}
uniform float u_time;
uniform float u_pointSize;
uniform float u_decadeSize;
uniform float u_lightSize;
uniform float u_maxSize;
flat out float v_size;
flat out float v_light;
void main() {
  float size = min(u_pointSize + u_decadeSize * max(a_extra.y - ${Math.log10(MIN_DIAMETER_KM).toFixed(5)}, 0.0), u_maxSize);
  v_size = size;
  v_light = pow(u_lightSize / size, ${LIGHT_SPREAD.toFixed(3)});
  // A pixel wider than the point, so pixels it only partly covers are drawn too.
  gl_PointSize = ceil(size) + 1.0;
  gl_Position = vec4(plotPosition(u_time) * u_scale + u_offset, 0.0, 1.0);
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
uniform vec2 u_roundSizes;
flat in float v_size;
flat in float v_light;
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
  float soften = 1.0 - ${EDGE_SOFTNESS.toFixed(3)} * smoothstep(u_roundSizes.y, u_roundSizes.y * 4.0, v_size) * edge * edge;
  float coverage = mix(square, circle * soften, roundness);
  color = vec4(u_weight * coverage * v_light, 0.0, 0.0, 0.0);
}`;

// One line strip per asteroid (an instance), running back in time from its position.
const TRAIL_VERTEX = `#version 300 es
${ORBIT_GLSL}
uniform float u_time;
uniform float u_trailDays;
out float v_fade;
void main() {
  float share = float(gl_VertexID) / ${(TRAIL_SAMPLES - 1).toFixed(1)};
  v_fade = pow(1.0 - share, ${TRAIL_FADE_POWER.toFixed(3)});
  gl_Position = vec4(plotPosition(u_time - share * u_trailDays) * u_scale + u_offset, 0.0, 1.0);
}`;

const TRAIL_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
in float v_fade;
out vec4 color;
void main() {
  color = vec4(u_weight * v_fade, 0.0, 0.0, 0.0);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TONE = `
float tone(float density) { return 1.0 - exp(-density); }`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_applyTone;
out vec4 color;
${TONE}
float read(vec2 offset) {
  float value = texture(u_source, v_uv + offset * u_texel).r;
  return mix(value, tone(value), u_applyTone);
}
void main() {
  float sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0))
            + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = vec4(sum * 0.25, 0.0, 0.0, 0.0);
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
uniform float u_nearGlow;
uniform float u_farGlow;
uniform vec3 u_trailColor;
uniform vec3 u_sunColor;
// The Sun's center in device pixels, then its radius and glow radius in device pixels.
uniform vec2 u_sun;
uniform vec2 u_sunSize;
out vec4 color;
${TONE}
const int STOP_COUNT = ${GRADIENT.length + 1};
uniform vec3 u_stops[STOP_COUNT];
vec3 gradient(float value) {
  float position = clamp(value, 0.0, 1.0) * float(STOP_COUNT - 1);
  int stop = min(int(position), STOP_COUNT - 2);
  return mix(u_stops[stop], u_stops[stop + 1], position - float(stop));
}
float noise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float core = tone(texture(u_density, v_uv).r);
  float near = clamp(texture(u_near, v_uv).r * u_nearGlow, 0.0, 1.0);
  float far = clamp(texture(u_far, v_uv).r * u_farGlow, 0.0, 1.0);
  float light = 1.0 - (1.0 - core) * (1.0 - near) * (1.0 - far);
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 rgb = gradient(light);
  // Trails sit under the points as a pale layer that doesn't feed the glow.
  vec3 trail = u_trailColor * tone(texture(u_trails, v_uv).r);
  rgb = 1.0 - (1.0 - rgb) * (1.0 - trail);
  // The Sun: a small disc with a soft halo.
  float distance = length(gl_FragCoord.xy - u_sun);
  float disc = clamp(u_sunSize.x + 0.5 - distance, 0.0, 1.0);
  float halo = 0.35 * exp(-3.0 * distance / u_sunSize.y);
  rgb = 1.0 - (1.0 - rgb) * (1.0 - u_sunColor * max(disc, halo));
  color = vec4(rgb, 1.0);
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

function createProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  uniformNames: string[],
): Program {
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

/**
 * Draws every asteroid at a moment in time. Positions are solved on the GPU from
 * each orbit, so moving time or the camera only changes uniforms. Points add into a
 * density buffer that a two-size glow turns into light; trails go into their own
 * buffer and are laid on as a pale layer.
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
  private gradient = new Float32Array(["#000000", ...GRADIENT].flatMap(hexChannels));

  constructor(
    private canvas: HTMLCanvasElement,
    private data: OrbitData,
    private errors: Errors,
  ) {
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

    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.orbits, gl.STATIC_DRAW);
    const stride = FLOATS_PER_ORBIT * 4;
    // Points read one orbit per vertex; trails one orbit per instance.
    const orbitVao = (divisor: number) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const layout: [number, number, number][] = [
        [0, 4, 0],
        [1, 4, 16],
        [2, 2, 32],
      ];
      for (const [location, size, offset] of layout) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, divisor);
      }
      gl.bindVertexArray(null);
      return vao;
    };

    const orbitUniforms = ["u_scale", "u_offset", "u_time"];
    this.resources = {
      points: createProgram(gl, POINT_VERTEX, POINT_FRAGMENT, [
        ...orbitUniforms,
        "u_pointSize",
        "u_decadeSize",
        "u_lightSize",
        "u_maxSize",
        "u_weight",
        "u_roundSizes",
      ]),
      trails: createProgram(gl, TRAIL_VERTEX, TRAIL_FRAGMENT, [...orbitUniforms, "u_trailDays", "u_weight"]),
      downsample: createProgram(gl, FULLSCREEN_VERTEX, DOWNSAMPLE_FRAGMENT, ["u_source", "u_texel", "u_applyTone"]),
      blur: createProgram(gl, FULLSCREEN_VERTEX, BLUR_FRAGMENT, ["u_source", "u_step"]),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT, [
        "u_density",
        "u_near",
        "u_far",
        "u_trails",
        "u_nearGlow",
        "u_farGlow",
        "u_trailColor",
        "u_sunColor",
        "u_sun",
        "u_sunSize",
        "u_stops",
      ]),
      pointsVao: orbitVao(0),
      trailsVao: orbitVao(1),
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

  private draw() {
    const { gl, resources, targets, pixelRatio } = this;
    if (!resources || !targets) return;
    const { scaleX, scaleY, offsetX, offsetY } = this.projection();
    const { zoom } = this.camera;
    const count = this.data.count;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Trails.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.trails.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const { trails } = resources;
    gl.useProgram(trails.program);
    gl.bindVertexArray(resources.trailsVao);
    gl.uniform2f(trails.uniforms.u_scale!, scaleX, scaleY);
    gl.uniform2f(trails.uniforms.u_offset!, offsetX, offsetY);
    gl.uniform1f(trails.uniforms.u_time!, this.time);
    gl.uniform1f(trails.uniforms.u_trailDays!, TRAIL_DAYS);
    gl.uniform1f(trails.uniforms.u_weight!, TRAIL_WEIGHT);
    gl.drawArraysInstanced(gl.LINE_STRIP, 0, TRAIL_SAMPLES, count);

    // Points.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.density.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const { points } = resources;
    gl.useProgram(points.program);
    gl.bindVertexArray(resources.pointsVao);
    const growth = zoomGrowth(zoom);
    gl.uniform2f(points.uniforms.u_scale!, scaleX, scaleY);
    gl.uniform2f(points.uniforms.u_offset!, offsetX, offsetY);
    gl.uniform1f(points.uniforms.u_time!, this.time);
    gl.uniform1f(points.uniforms.u_pointSize!, Math.max(0.5, POINT_SIZE * growth * pixelRatio));
    gl.uniform1f(points.uniforms.u_decadeSize!, SIZE_PER_DECADE * growth * pixelRatio);
    gl.uniform1f(points.uniforms.u_lightSize!, Math.max(0.5, LIGHT_BASE_SIZE * growth * pixelRatio));
    gl.uniform1f(points.uniforms.u_maxSize!, this.maxPointSize - 1);
    gl.uniform1f(points.uniforms.u_weight!, POINT_WEIGHT * (1 + ZOOM_BRIGHTNESS * Math.log2(zoom)));
    gl.uniform2f(points.uniforms.u_roundSizes!, ROUND_POINT_SIZES[0]!, ROUND_POINT_SIZES[1]!);
    gl.drawArrays(gl.POINTS, 0, count);

    gl.disable(gl.BLEND);
    this.drawGlow(resources, targets, offsetX, offsetY);
  }

  private drawGlow(resources: Resources, targets: Targets, offsetX: number, offsetY: number) {
    const { gl, pixelRatio } = this;
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
    ];
    textures.forEach(([name, target], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.uniform1i(composite.uniforms[name]!, unit);
    });
    gl.uniform1f(composite.uniforms.u_nearGlow!, NEAR_GLOW);
    gl.uniform1f(composite.uniforms.u_farGlow!, FAR_GLOW);
    gl.uniform3fv(composite.uniforms.u_stops!, this.gradient);
    const trailColor = hexChannels(TRAIL_COLOR).map((channel) => channel * TRAIL_STRENGTH);
    gl.uniform3f(composite.uniforms.u_trailColor!, trailColor[0]!, trailColor[1]!, trailColor[2]!);
    const sun = hexChannels(SUN_COLOR);
    gl.uniform3f(composite.uniforms.u_sunColor!, sun[0]!, sun[1]!, sun[2]!);
    // The Sun sits at the plot's origin, which is clip position (offsetX, offsetY).
    gl.uniform2f(
      composite.uniforms.u_sun!,
      ((offsetX + 1) / 2) * this.canvas.width,
      ((offsetY + 1) / 2) * this.canvas.height,
    );
    gl.uniform2f(composite.uniforms.u_sunSize!, SUN_RADIUS * pixelRatio, SUN_GLOW_RADIUS * pixelRatio);
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
