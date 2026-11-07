/**
 * 背景烟雾层：全屏片元着色器。
 * - 暖炭底色上用域扭曲 fbm 画缓慢漂移的烟；显示器位置作为光源，把附近的烟染成屏幕的颜色
 *   （青 → 品红缓慢轮换）。
 * - uScene 从 0 到 1 过渡到胶片段落的深蓝夜空；uDim 压暗正文区域保证可读。
 * - 只以半分辨率渲染，烟雾是低频内容，放大后看不出差别。
 */
import { createContext, createProgram, releaseContext, resizeCanvas } from './gl.js';

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uLight;
uniform float uLightAmt;
uniform vec3 uTint;
uniform float uScene;
uniform float uDim;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.035;

  vec2 q = vec2(fbm(p * 1.4 + vec2(0.0, t)), fbm(p * 1.4 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 1.8 + 2.4 * q + vec2(1.7, 9.2) + t * 1.4), fbm(p * 1.8 + 2.4 * q + vec2(8.3, 2.8) - t));
  float smoke = fbm(p * 2.0 + 2.6 * r);
  smoke = smoothstep(0.25, 0.95, smoke);

  vec2 lp = (uLight * uRes - 0.5 * uRes) / uRes.y;
  float d = length((p - lp) * vec2(0.8, 1.15));
  float glow = exp(-d * 2.4) * uLightAmt;

  vec3 base = vec3(0.110, 0.102, 0.094);
  vec3 haze = mix(vec3(0.24, 0.20, 0.22), uTint, 0.55);
  vec3 col = base;
  col += haze * smoke * (0.55 + 2.6 * glow);
  col += uTint * glow * 0.3;
  col += vec3(0.22, 0.18, 0.21) * smoke * smoke * smoothstep(0.15, -0.65, p.y);

  // 夜空：顶部深海军蓝，向下过渡到亮一些的钴蓝地平线，叠一层冷色薄云与稀疏星点
  vec3 sky = mix(vec3(0.17, 0.22, 0.62), vec3(0.03, 0.035, 0.14), smoothstep(-0.55, 0.6, p.y));
  sky += vec3(0.30, 0.42, 0.85) * pow(smoothstep(-0.1, -0.75, p.y), 2.0) * 0.55;
  sky += vec3(0.42, 0.40, 0.85) * smoke * 0.16;
  vec2 sg = floor(gl_FragCoord.xy);
  float star = step(0.9993, hash(sg)) * smoothstep(-0.1, 0.5, p.y);
  sky += star * (0.5 + 0.5 * sin(uTime * 2.0 + hash(sg + 3.1) * 40.0)) * 0.45;
  col = mix(col, sky, uScene);

  col *= mix(1.0, 0.55, uDim);
  col *= 1.0 - 0.5 * pow(length(uv - 0.5) * 1.22, 2.6);
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.0) * 113.0) - 0.5) * 0.03;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSmoke(canvas, { still = false } = {}) {
  const gl = createContext(canvas);
  if (!gl) return null;
  let prog;
  try {
    prog = createProgram(gl, VERT, FRAG);
  } catch (error) {
    console.warn(error);
    return null;
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog.program, 'aPos');

  const params = { light: [0.72, 0.5], lightAmt: 1, scene: 0, dim: 0 };
  const start = performance.now();

  function draw(now) {
    resizeCanvas(canvas, 0.5);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const t = still ? 18 : (now - start) / 1000;
    // 屏幕光色在青与品红之间慢慢来回
    const k = 0.5 + 0.5 * Math.sin(t * 0.18);
    const tint = [0.25 + 0.64 * k, 0.55 - 0.13 * k, 0.68 + 0.23 * k];
    const u = prog.uniforms;
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uTime, t);
    gl.uniform2f(u.uLight, params.light[0], params.light[1]);
    gl.uniform1f(u.uLightAmt, params.lightAmt);
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.uScene, params.scene);
    gl.uniform1f(u.uDim, params.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function dispose() {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(prog.program);
    releaseContext(gl);
  }

  return { params, draw, dispose };
}
