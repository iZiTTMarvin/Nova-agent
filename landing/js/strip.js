/**
 * 胶片画廊：真实截图贴在一条弯曲、微微倾斜的胶片上，由编排层按恒定速度环绕放映，截图首尾相接循环。
 *
 * 坐标约定：胶片空间里画面高 H=1、宽 W=1.6（与 1280×800 截图同比例），第 k 个槽位中心位于 x=k·PITCH，
 * 槽位 k 显示截图 mod(k, count)。顶点着色器把胶片空间坐标绕竖直轴弯成圆弧（两端朝观众靠近），再整体倾斜、
 * 透视投影；胶片底带与画面共用 project()，CPU 侧用同一套公式反算屏幕四角，供指针命中与接片动画起点使用。
 * 圆角、齿孔与相框用 SDF + fwidth 解析抗锯齿：MSAA 管不到片元里的 discard，硬切边一定是锯齿。
 */
import { createContext, createProgram, releaseContext, resizeCanvas } from './gl.js';

export const FRAME_W = 1.6;
export const FRAME_H = 1;
export const PITCH = 1.86;
const MARGIN = 0.17;
const FOV = (32 * Math.PI) / 180;
const F = 1 / Math.tan(FOV / 2);
const RADIUS = 3.3;
const TILT = -0.115;
const LIFT = -0.2;
const PAD = 0.055;
const VISIBLE = 5.2;
const FILM_SEGMENTS = 360;
const FILM_SEG_W = 0.03;

const VERT = `
attribute vec2 aPos;
uniform vec4 uRect;      // x0, y0, w, h（胶片空间）
uniform vec2 uPad;       // 四边形外扩，给抗锯齿与接触阴影留出片元
uniform float uScroll;
uniform float uAspect;
uniform float uCam;
uniform float uPop;      // 悬停时朝镜头抬起并微放大
varying vec2 vUv;
varying vec2 vStrip;
varying float vDist;

vec3 project(vec2 s, float scroll) {
  float x = s.x - scroll;
  float a = x / ${RADIUS.toFixed(4)};
  vec3 p = vec3(${RADIUS.toFixed(4)} * sin(a), s.y, ${RADIUS.toFixed(4)} * (1.0 - cos(a)) * 0.5);
  float c = cos(${TILT.toFixed(5)});
  float sn = sin(${TILT.toFixed(5)});
  p.xy = vec2(c * p.x - sn * p.y, sn * p.x + c * p.y);
  p.y += ${LIFT.toFixed(4)};
  return p;
}

void main() {
  vec2 q = aPos * (1.0 + 2.0 * uPad) - uPad;
  vec2 s = uRect.xy + q * uRect.zw;
  vec3 p = project(s, uScroll);
  p.xy *= 1.0 + uPop * 0.05;
  p.z += uPop * 0.22;
  float vz = p.z - uCam;
  float n = 0.1;
  float fa = 40.0;
  gl_Position = vec4(p.x * ${F.toFixed(5)} / uAspect, p.y * ${F.toFixed(5)}, (vz * (n + fa) + 2.0 * fa * n) / (n - fa), -vz);
  vUv = q;
  vStrip = s;
  vDist = s.x - uScroll;
}
`;

const AA = `
float aaStep(float edge) {
  float w = max(fwidth(edge), 1e-5);
  return smoothstep(-w, w, edge);
}
float boxSdf(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const FILM_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vStrip;
varying float vDist;
uniform float uHalfH;
uniform float uMargin;
uniform float uDim;
${AA}

void main() {
  float ay = abs(vStrip.y);
  float body = aaStep(uHalfH + uMargin - ay);
  if (body <= 0.001) discard;
  float band = (ay - uHalfH) / uMargin;
  // 齿孔：上下两条带里按固定节距挖空，透出背后的夜空
  float hole = 1.0;
  float rim = 0.0;
  if (band > 0.06 && band < 0.98) {
    vec2 cell = vec2(mod(vStrip.x, 0.105) - 0.0525, (band - 0.52) * uMargin);
    float hd = boxSdf(cell, vec2(0.026, uMargin * 0.2), 0.008);
    hole = aaStep(hd);
    rim = (1.0 - hole) * (1.0 - aaStep(hd - 0.006));
  }
  vec3 film = vec3(0.026, 0.030, 0.072);
  film += vec3(0.07, 0.08, 0.19) * (1.0 - smoothstep(0.0, 1.0, abs(vUv.y - 0.5) * 2.0)) * 0.4;
  film += vec3(0.16, 0.18, 0.42) * smoothstep(0.88, 1.0, band) * 0.7;
  film += vec3(0.22, 0.24, 0.46) * rim;
  film *= uDim;
  float fade = 1.0 - smoothstep(2.6, 4.6, abs(vDist));
  gl_FragColor = vec4(film, body * hole * fade);
}
`;

const FRAME_FRAG = `
precision highp float;
varying vec2 vUv;
varying float vDist;
uniform sampler2D uTex;
uniform float uHasTex;
uniform float uFocus;
uniform float uHover;
uniform float uDim;
${AA}

const vec2 HALF = vec2(${(FRAME_W / 2).toFixed(3)}, ${(FRAME_H / 2).toFixed(3)});
const float BEZEL = 0.017;

void main() {
  vec2 p = (vUv - 0.5) * vec2(${FRAME_W.toFixed(3)}, ${FRAME_H.toFixed(3)});
  float d = boxSdf(p, HALF, 0.032);
  float inside = 1.0 - aaStep(d);
  float shadow = (1.0 - aaStep(d - 0.05)) * (1.0 - inside);
  float alpha = max(inside, shadow * 0.6);
  if (alpha <= 0.002) discard;

  float di = boxSdf(p, HALF - BEZEL, 0.018);
  float screen = (1.0 - aaStep(di)) * inside;
  float lit = clamp(uFocus + uHover, 0.0, 1.0);

  vec2 uv = vec2(clamp(vUv.x, 0.0, 1.0), 1.0 - clamp(vUv.y, 0.0, 1.0));
  vec3 tex = vec3(0.10, 0.11, 0.16);
  if (uHasTex > 0.5) {
    // 缩小显示后补一点反锐化，细小界面文字才不发糊
    vec2 o = (abs(dFdx(uv)) + abs(dFdy(uv))) * 0.5;
    vec3 c = texture2D(uTex, uv, -0.3).rgb;
    vec3 blur = (texture2D(uTex, uv + vec2(o.x, 0.0)).rgb + texture2D(uTex, uv - vec2(o.x, 0.0)).rgb
               + texture2D(uTex, uv + vec2(0.0, o.y)).rgb + texture2D(uTex, uv - vec2(0.0, o.y)).rgb) * 0.25;
    tex = clamp(c + (c - blur) * 0.7, 0.0, 1.0);
  }
  // 压住纯白的刺眼感：整体略收、偏暖，远处的帧再退一档
  tex *= vec3(0.955, 0.94, 0.915);
  float gray = dot(tex, vec3(0.299, 0.587, 0.114));
  tex = mix(vec3(gray), tex, mix(0.6, 1.0, lit));
  tex *= mix(0.46, 1.0, lit);
  // 屏幕嵌在相框里：贴边处内凹变暗，顶部受光、四周略暗
  float recess = 1.0 - smoothstep(0.0, 0.02, -di);
  tex *= 1.0 - 0.38 * recess;
  tex *= 1.0 - 0.14 * smoothstep(0.35, 1.05, length(p / HALF));

  // 相框：深色金属边，顶部受光的一圈细高光
  vec3 bezel = vec3(0.052, 0.055, 0.07) + vec3(0.05, 0.055, 0.07) * smoothstep(-0.5, 0.5, p.y);
  float edge = inside * aaStep(d + 0.0032);
  vec3 col = mix(bezel, tex, screen);
  col += vec3(0.5, 0.52, 0.62) * edge * (0.14 + 0.5 * smoothstep(-0.3, 0.5, p.y)) * (0.4 + 0.6 * lit);
  // 悬停：暖色描边光，明确「这一格被选中了」
  float ring = inside * aaStep(d + 0.0075) * (1.0 - aaStep(d + 0.0008));
  col = mix(col, vec3(1.0, 0.78, 0.46), ring * uHover * 0.95);
  col *= uDim;

  vec3 shadowCol = mix(vec3(0.004, 0.005, 0.02), vec3(0.45, 0.28, 0.08), uHover * (1.0 - smoothstep(0.0, 0.05, d)) * 0.55);
  float fade = 1.0 - smoothstep(2.6, 4.6, abs(vDist));
  vec3 outCol = mix(shadowCol, col, inside / max(alpha, 1e-4));
  gl_FragColor = vec4(outCol, alpha * fade);
}
`;

function grid(segments) {
  const data = [];
  for (let i = 0; i < segments; i++) {
    const a = i / segments;
    const b = (i + 1) / segments;
    data.push(a, 0, b, 0, a, 1, a, 1, b, 0, b, 1);
  }
  return new Float32Array(data);
}

/** 与顶点着色器同一套变换：返回某点在画布里的 CSS 像素坐标。 */
function projectPoint(sx, sy, view, width, height) {
  const x = sx - view.scroll;
  const a = x / RADIUS;
  const bx = RADIUS * Math.sin(a);
  const bz = RADIUS * (1 - Math.cos(a)) * 0.5;
  const c = Math.cos(TILT);
  const s = Math.sin(TILT);
  const px = c * bx - s * sy;
  const py = s * bx + c * sy + LIFT;
  const w = view.cam - bz;
  if (w <= 0.05) return null;
  return {
    x: (((px * F) / view.aspect / w + 1) / 2) * width,
    y: ((1 - (py * F) / w) / 2) * height
  };
}

export function createStrip(canvas, sources) {
  const gl = createContext(canvas, { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (!isGL2 && !gl.getExtension('OES_standard_derivatives')) return null;
  // 片元用 fwidth 做解析抗锯齿：WebGL2 里导数属核心，WebGL1 需开扩展；着色器正文保持 ES 1.00 写法，靠宏桥接到 ES 3.00
  const vertHead = isGL2 ? '#version 300 es\n#define attribute in\n#define varying out\n' : '';
  const fragHead = isGL2
    ? '#version 300 es\nprecision highp float;\n#define varying in\n#define texture2D texture\nout vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n'
    : '#extension GL_OES_standard_derivatives : enable\n';
  let film;
  let frame;
  try {
    film = createProgram(gl, vertHead + VERT, fragHead + FILM_FRAG);
    frame = createProgram(gl, vertHead + VERT, fragHead + FRAME_FRAG);
  } catch (error) {
    console.warn(error);
    return null;
  }

  const meshes = {};
  for (const [name, segs] of [['film', FILM_SEGMENTS], ['frame', 56]]) {
    const buffer = gl.createBuffer();
    const data = grid(segs);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    meshes[name] = { buffer, count: data.length / 2 };
  }

  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  let disposed = false;
  const textures = sources.map(src => {
    const entry = { tex: gl.createTexture(), ready: false };
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    img.decode().then(() => {
      // 解码是异步的，可能晚于卸载完成
      if (disposed) return;
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (isGL2) {
        // 截图里是细小文字，缩小显示必须有 mipmap，否则会闪烁发糊
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      entry.ready = true;
    }).catch(() => {});
    return entry;
  });

  const count = sources.length;
  const state = { aspect: 1, cam: 4, scroll: 0, width: 1, height: 1 };

  function bindMesh(prog, mesh) {
    const loc = gl.getAttribLocation(prog.program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  function common(prog, view) {
    const u = prog.uniforms;
    gl.uniform1f(u.uScroll, view.scroll);
    gl.uniform1f(u.uAspect, state.aspect);
    gl.uniform1f(u.uCam, state.cam);
    gl.uniform1f(u.uDim, view.dim);
  }

  /**
   * view.scroll 为胶片空间横向位置（槽位 k 居中时等于 k·PITCH），可无限增长；
   * view.hover 按截图序号给出悬停权重，view.dim 为灯箱打开时整条胶片的退焦压暗。
   */
  function render(view) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    resizeCanvas(canvas, dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    state.width = canvas.clientWidth;
    state.height = canvas.clientHeight;
    state.aspect = canvas.width / canvas.height;
    state.scroll = view.scroll;
    // 居中画面约占视口高度 40%，窄屏时以宽度 72% 为上限
    const heightFrac = Math.min(0.4, (0.72 * state.aspect * FRAME_H) / FRAME_W);
    state.cam = (F * FRAME_H) / (2 * heightFrac);

    gl.useProgram(film.program);
    common(film, view);
    bindMesh(film, meshes.film);
    // 胶片底带跟着镜头走，顶点吸附到固定网格，齿孔图案由片元按世界坐标生成，滑动时不会漂移
    const x0 = Math.floor((view.scroll - (FILM_SEGMENTS * FILM_SEG_W) / 2) / FILM_SEG_W) * FILM_SEG_W;
    gl.uniform4f(film.uniforms.uRect, x0, -(FRAME_H / 2 + MARGIN), FILM_SEGMENTS * FILM_SEG_W, FRAME_H + 2 * MARGIN);
    gl.uniform2f(film.uniforms.uPad, 0, 0);
    gl.uniform1f(film.uniforms.uPop, 0);
    gl.uniform1f(film.uniforms.uHalfH, FRAME_H / 2);
    gl.uniform1f(film.uniforms.uMargin, MARGIN);
    gl.drawArrays(gl.TRIANGLES, 0, meshes.film.count);

    gl.useProgram(frame.program);
    common(frame, view);
    bindMesh(frame, meshes.frame);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(frame.uniforms.uTex, 0);
    gl.uniform2f(frame.uniforms.uPad, PAD / FRAME_W, PAD / FRAME_H);
    const first = Math.ceil((view.scroll - VISIBLE) / PITCH);
    const last = Math.floor((view.scroll + VISIBLE) / PITCH);
    for (let slot = first; slot <= last; slot++) {
      const index = ((slot % count) + count) % count;
      const center = slot * PITCH;
      const off = center - view.scroll;
      const focus = 1 - Math.min(1, Math.abs(off) / (PITCH * 0.85));
      const hover = view.hover[index] || 0;
      gl.bindTexture(gl.TEXTURE_2D, textures[index].tex);
      gl.uniform1f(frame.uniforms.uHasTex, textures[index].ready ? 1 : 0);
      gl.uniform1f(frame.uniforms.uFocus, focus * focus * (3 - 2 * focus));
      gl.uniform1f(frame.uniforms.uHover, hover);
      gl.uniform1f(frame.uniforms.uPop, hover);
      gl.uniform4f(frame.uniforms.uRect, center - FRAME_W / 2, -FRAME_H / 2, FRAME_W, FRAME_H);
      gl.drawArrays(gl.TRIANGLES, 0, meshes.frame.count);
    }
  }

  /** 某个槽位的画面在画布里的四角（CSS 像素，左上原点）；用于指针命中与接片动画起点。 */
  function frameQuad(slot, pop = 0) {
    const cx = slot * PITCH;
    const k = 1 + pop * 0.05;
    const zoom = 1 + pop * 0.06;
    const corners = [
      [cx - (FRAME_W / 2) * k, (FRAME_H / 2) * k],
      [cx + (FRAME_W / 2) * k, (FRAME_H / 2) * k],
      [cx + (FRAME_W / 2) * k, -(FRAME_H / 2) * k],
      [cx - (FRAME_W / 2) * k, -(FRAME_H / 2) * k]
    ];
    const out = [];
    for (const [sx, sy] of corners) {
      const p = projectPoint(sx, sy, state, state.width, state.height);
      if (!p) return null;
      out.push({
        x: state.width / 2 + (p.x - state.width / 2) * zoom,
        y: state.height / 2 + (p.y - state.height / 2) * zoom
      });
    }
    return out;
  }

  function dispose() {
    disposed = true;
    textures.forEach(entry => gl.deleteTexture(entry.tex));
    Object.values(meshes).forEach(mesh => gl.deleteBuffer(mesh.buffer));
    gl.deleteProgram(film.program);
    gl.deleteProgram(frame.program);
    releaseContext(gl);
  }

  return { render, frameQuad, dispose, count };
}

/** 凸四边形命中测试：点相对四条边同侧即在内。 */
export function pointInQuad(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 四角的轴对齐包围盒，作为接片动画的起点矩形。 */
export function quadBounds(quad) {
  const xs = quad.map(p => p.x);
  const ys = quad.map(p => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
