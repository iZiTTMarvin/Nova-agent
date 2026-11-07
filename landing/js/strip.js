/**
 * 胶片画廊：真实截图贴在一条弯曲、微微倾斜的胶片上，滚动推动胶片横移。
 *
 * 坐标约定：胶片空间里画面高 H=1、宽 W=1.6（与 1280×800 截图同比例），第 i 帧中心位于 x=i·PITCH。
 * 顶点着色器把胶片空间坐标绕竖直轴弯成圆弧（两端朝观众靠近），再整体倾斜、透视投影；
 * 胶片底带和画面各画一遍，共用同一套弯曲函数，保证接缝严丝合缝。
 */
import { createContext, createProgram, releaseContext, resizeCanvas } from './gl.js';

export const FRAME_W = 1.6;
export const FRAME_H = 1;
export const PITCH = 1.86;
const MARGIN = 0.17;
const FOV = (32 * Math.PI) / 180;

const VERT = `
attribute vec2 aPos;
uniform vec4 uRect;      // x0, y0, w, h（胶片空间）
uniform float uScroll;
uniform float uRadius;
uniform float uTilt;
uniform float uVel;
uniform float uAspect;
uniform float uCam;
uniform float uLift;
varying vec2 vUv;
varying vec2 vStrip;
varying float vDist;

void main() {
  float sx = uRect.x + aPos.x * uRect.z;
  float sy = uRect.y + aPos.y * uRect.w;
  float x = sx - uScroll;
  float a = x / uRadius;
  vec3 p = vec3(uRadius * sin(a), sy + x * uVel, uRadius * (1.0 - cos(a)) * 0.5);
  float c = cos(uTilt);
  float s = sin(uTilt);
  p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p.y += uLift;
  float f = 1.0 / tan(${(FOV / 2).toFixed(5)});
  float vz = p.z - uCam;
  float n = 0.1;
  float fa = 40.0;
  gl_Position = vec4(p.x * f / uAspect, p.y * f, (vz * (n + fa) + 2.0 * fa * n) / (n - fa), -vz);
  vUv = aPos;
  vStrip = vec2(sx, sy);
  vDist = x;
}
`;

const FILM_FRAG = `
precision highp float;
varying vec2 vUv;
varying vec2 vStrip;
varying float vDist;
uniform float uHalfH;
uniform float uMargin;

float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float ay = abs(vStrip.y);
  if (ay > uHalfH + uMargin) discard;
  float band = (ay - uHalfH) / uMargin;
  // 齿孔：上下两条带里按固定节距挖空，透出背后的夜空
  if (band > 0.18 && band < 0.86) {
    float hp = 0.105;
    vec2 cell = vec2(mod(vStrip.x, hp) - hp * 0.5, (band - 0.52) * uMargin);
    if (box(cell, vec2(0.026, uMargin * 0.2), 0.008) < 0.0) discard;
  }
  vec3 film = vec3(0.035, 0.04, 0.095);
  film += vec3(0.08, 0.09, 0.2) * (1.0 - smoothstep(0.0, 1.0, abs(vUv.y - 0.5) * 2.0)) * 0.35;
  film += vec3(0.15, 0.17, 0.4) * smoothstep(0.9, 1.0, band) * 0.6;
  float fade = 1.0 - smoothstep(2.6, 4.6, abs(vDist));
  gl_FragColor = vec4(film, fade);
}
`;

const FRAME_FRAG = `
precision highp float;
varying vec2 vUv;
varying float vDist;
uniform sampler2D uTex;
uniform float uHasTex;
uniform float uFocus;

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 q = abs(uv - 0.5) - vec2(0.5 - 0.012, 0.5 - 0.019);
  if (length(max(q, 0.0)) > 0.012) discard;
  vec3 tex = uHasTex > 0.5 ? texture2D(uTex, uv).rgb : vec3(0.12, 0.13, 0.2);
  float gray = dot(tex, vec3(0.299, 0.587, 0.114));
  vec3 dim = mix(vec3(gray), tex, 0.15) * 0.4 + vec3(0.02, 0.03, 0.1);
  // 截图本身偏浅，焦点帧略提对比度；扫描线交给全局 CRT 层，这里再叠会在缩小后产生摩尔纹
  vec3 sharp = clamp((tex - 0.5) * 1.08 + 0.48, 0.0, 1.0);
  vec3 col = mix(dim, sharp, uFocus);
  col *= 1.0 - 0.28 * pow(length(uv - 0.5) * 1.3, 3.0);
  float fade = 1.0 - smoothstep(2.6, 4.6, abs(vDist));
  gl_FragColor = vec4(col, fade);
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

export function createStrip(canvas, sources) {
  const gl = createContext(canvas, { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return null;
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  let film;
  let frame;
  try {
    film = createProgram(gl, VERT, FILM_FRAG);
    frame = createProgram(gl, VERT, FRAME_FRAG);
  } catch (error) {
    console.warn(error);
    return null;
  }

  const meshes = {};
  for (const [name, segs] of [['film', 520], ['frame', 56]]) {
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

  function bindMesh(prog, mesh) {
    const loc = gl.getAttribLocation(prog.program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  function common(prog, view) {
    const u = prog.uniforms;
    gl.uniform1f(u.uScroll, view.scroll);
    gl.uniform1f(u.uRadius, 3.3);
    gl.uniform1f(u.uTilt, -0.115);
    gl.uniform1f(u.uVel, view.vel);
    gl.uniform1f(u.uAspect, view.aspect);
    gl.uniform1f(u.uCam, view.cam);
    gl.uniform1f(u.uLift, -0.2);
  }

  /**
   * 渲染一帧。view.scroll 为胶片空间横向位置（第 i 帧居中时等于 i·PITCH），view.vel 为滚动速度带来的剪切。
   */
  function render(view) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    resizeCanvas(canvas, dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const aspect = canvas.width / canvas.height;
    // 让居中画面约占视口高度 35%，窄屏时以宽度 66% 为上限
    let heightFrac = 0.35;
    heightFrac = Math.min(heightFrac, (0.66 * aspect * FRAME_H) / FRAME_W);
    const f = 1 / Math.tan(FOV / 2);
    const cam = (f * FRAME_H) / (2 * heightFrac);
    const v = { ...view, aspect, cam };

    gl.useProgram(film.program);
    common(film, v);
    bindMesh(film, meshes.film);
    const span = count * PITCH + 4 * PITCH;
    gl.uniform4f(film.uniforms.uRect, -2 * PITCH, -(FRAME_H / 2 + MARGIN), span, FRAME_H + 2 * MARGIN);
    gl.uniform1f(film.uniforms.uHalfH, FRAME_H / 2);
    gl.uniform1f(film.uniforms.uMargin, MARGIN);
    gl.drawArrays(gl.TRIANGLES, 0, meshes.film.count);

    gl.useProgram(frame.program);
    common(frame, v);
    bindMesh(frame, meshes.frame);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(frame.uniforms.uTex, 0);
    for (let i = 0; i < count; i++) {
      const center = i * PITCH;
      if (Math.abs(center - view.scroll) > 5.2) continue;
      const focus = 1 - Math.min(1, Math.abs(center - view.scroll) / (PITCH * 0.75));
      gl.bindTexture(gl.TEXTURE_2D, textures[i].tex);
      gl.uniform1f(frame.uniforms.uHasTex, textures[i].ready ? 1 : 0);
      gl.uniform1f(frame.uniforms.uFocus, focus * focus * (3 - 2 * focus));
      gl.uniform4f(frame.uniforms.uRect, center - FRAME_W / 2, -FRAME_H / 2, FRAME_W, FRAME_H);
      gl.drawArrays(gl.TRIANGLES, 0, meshes.frame.count);
    }
  }

  function dispose() {
    disposed = true;
    textures.forEach(entry => gl.deleteTexture(entry.tex));
    Object.values(meshes).forEach(mesh => gl.deleteBuffer(mesh.buffer));
    gl.deleteProgram(film.program);
    gl.deleteProgram(frame.program);
    releaseContext(gl);
  }

  return { render, dispose, count };
}
