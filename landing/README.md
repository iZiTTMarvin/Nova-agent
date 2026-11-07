# landing — Nova Agent 宣传落地页

静态单页站点，不参与 Electron 应用构建，不引入任何依赖。整页是一段滚动驱动的镜头：
WebGL 烟雾里一台复古显示器，屏幕里运行着按真实界面复刻的 Nova；滚动时镜头推进、
穿过屏幕，转入夜空下的弧形胶片带，逐帧展示真实应用截图，再落到能力、对比、上手、技能与 FAQ。

| 段落 | 内容 |
|---|---|
| 首屏 | 显示器内的 Nova 演示自动播放六章：一句话开工 → 危险操作先问你 → 改动逐个审 → 学懂这次改动 → 考考你 → 项目大纲；底部章节条可点选跳转 |
| 胶片带 | 八张真实 Electron 截图贴在弧形 WebGL 胶片上，滚动推进，聚焦帧放大并配标题 |
| 正文 | 能力 / 对比 / 三分钟上手 / 技能 / FAQ / 下载 |

演示里的界面结构、文案与配色取自应用源码（浅色主题、学习模式文案、等待指示等），
**对话内容是脚本编写的**，页面上也明确标注了这一点。

## 本地预览

WebGL 纹理需要同源加载，必须经 HTTP 打开，不能直接双击 `index.html`。

```bash
cd landing
python -m http.server 8899
# 浏览器打开 http://localhost:8899
```

## 目录

| 路径 | 说明 |
|------|------|
| `index.html` | 页面结构与全部文案；首帧前的内联脚本决定动效档位 |
| `styles.css` | 设计 token、页面布局、显示器与胶片带样式、降级样式 |
| `sim.css` | 显示器内 Nova 复刻界面的样式（`.nv*`） |
| `main.js` | 唯一的 rAF 循环：首屏推镜、胶片带进度、烟雾参数、导航底衬；离屏时暂停演示 |
| `js/sim.js` | Nova 界面复刻与六章脚本，提供 `play / show / pause / resume / stop` |
| `js/smoke.js` | 全屏烟雾与夜空着色器 |
| `js/strip.js` | 弧形胶片带着色器与纹理加载 |
| `js/gl.js` | WebGL 上下文、着色器编译、画布尺寸同步 |
| `assets/shots/dev-*.png`、`learn-*.png` | 胶片带用的真实界面截图（1280×800） |
| `fonts/` | STIX Two Text、JetBrains Mono，以及只含展示标题用字的 Noto Serif SC 子集 |

## 动效档位与降级

`<html>` 在首帧前被打上其中一个类：

- `is-cinema`：默认档，首屏与胶片带钉住，由滚动驱动。
- `is-static`：系统开启 `prefers-reduced-motion` 或视口宽度 ≤ 860px 时启用。取消钉住，
  烟雾静止，显示器直接停在「学懂这次改动」一章，胶片带改为纵向图文列表。
- 浏览器拿不到 WebGL 时，胶片带退化为两列截图网格，烟雾画布留空，露出纯色底。

演示离开视口即暂停；页面真正卸载时停止 rAF 循环和演示脚本，并释放全部 WebGL 资源。
进入浏览器往返缓存时不释放，以便返回后继续播放。

## 修改标题后重新取字

中文展示标题用的是按需子集字体，新增或修改 `.display` 标题、胶片 `data-title` 后，
在仓库根目录重新生成（需要联网）：

```bash
node scripts/subset-landing-font.mjs
```

## 重新截取界面截图

截图由真实 Electron 应用渲染：e2e 夹具起一个脚本化的模型服务，驱动 Nova 依次走完
开发会话（读文件、写文件、危险命令授权、逐文件审阅、学懂这次改动）和学习会话
（讲解、考考我、生成大纲），在每个节点截图写入 `assets/shots/`。

```bash
npm run build
cd tests/e2e
npx playwright test landing-capture
```

截图脚本在 `tests/e2e/landing-capture/`，是手动工具，不属于回归测试。

## 部署

整个 `landing/` 目录即产物根目录，任意静态托管（GitHub Pages、Vercel、Netlify、
对象存储 + CDN）可直接使用，无需构建步骤。
