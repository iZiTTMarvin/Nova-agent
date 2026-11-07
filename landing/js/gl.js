/** WebGL 小工具：建上下文、编译着色器程序、建全屏三角形。两个画布共用。 */

export function createContext(canvas, options = {}) {
  const attrs = { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance', ...options };
  const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
  return gl || null;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：${log}`);
  }
  return shader;
}

export function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // 链接后着色器只需标记删除，随 program 一起释放
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败：${log}`);
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

/** 主动交还 GPU 上下文；不等垃圾回收，页面卸载时显存立即释放。 */
export function releaseContext(gl) {
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

/** 画布像素尺寸跟随 CSS 尺寸；scale 用于降采样（烟雾层只需半分辨率）。 */
export function resizeCanvas(canvas, scale) {
  const width = Math.max(1, Math.round(canvas.clientWidth * scale));
  const height = Math.max(1, Math.round(canvas.clientHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}
