# 真实设计系统地图 — 何时用官方包，别手搓

> **中文说明**：某些 brief 指向的是有官方设计系统的场景。诚实规则：命中就装官方包，别手写它的 CSS、别导入它的 token 又覆盖 90%。
> **何时加载**：brief 读起来像企业 SaaS / 政务 / Shopify / 特定平台产品时；或需要安装命令与官方文档锚点时。
> **核心**：一个项目一套系统。别把 Fluent React 和 Carbon 混在同一棵树；别把 shadcn/ui 组件导入 Material 3 app。

---

## 1. 何时伸手拿真实设计系统（用官方包）

| brief 读起来像… | 用 | 为什么 |
|-----------------|-----|--------|
| 微软 / 企业 SaaS / dashboard | `@fluentui/react-components` 或 `@fluentui/web-components` | 官方 Fluent UI，微软 token，无障碍已做好 |
| Google 风、Material 味产品 | `@material/web` + Material 3 token | 官方，可经 Material Theming 主题化 |
| IBM 式 B2B / 企业分析 | `@carbon/react` + `@carbon/styles` | 官方 Carbon，成熟的数据密度模式 |
| Shopify app 界面 | Polaris web components / Polaris React | Shopify admin UI 必需 |
| Atlassian / Jira 式产品 | `@atlaskit/*` + `@atlaskit/tokens` | 官方 Atlassian DS |
| GitHub 式开发工具/社区页 | `@primer/css` 或 `@primer/react-brand` | 官方 Primer；Brand 变体用于营销 |
| 英国政务服务 | `govuk-frontend` | 法规/监管预期 |
| 美国政务 / 信任优先 | `uswds` | 同上 |
| 本地商户 / agency 快速 MVP | Bootstrap 5.3 | 无聊、快、能用 |
| 现代无障碍 React 基座 | `@radix-ui/themes` | 原语 + 打磨主题 |
| 现代 SaaS 且要自己拥有组件 | shadcn/ui（`npx shadcn@latest add …`） | 你拥有代码，易定制；绝不发默认态 |
| Tailwind 现代 SaaS / AI 营销 | Tailwind v4 utilities + `dark:` 变体 | indie + 小团队默认 |

**诚实规则**：读起来像上面某个系统 → 装并用**官方**包，别手搓其 CSS，别导 token 又覆盖 90%。**一个项目一套系统。**

---

## 2. 当 brief 是一种审美、而非一套系统

这些方向**没有单一官方包**。用原生 CSS + Tailwind + 维护良好的组件库构建。代码注释里诚实标注哪些是借来的灵感 vs 官方素材。

| 审美 | 诚实实现 |
|------|----------|
| Glassmorphism / 磨砂玻璃 | `backdrop-filter`、分层边框、高光叠加。给 `prefers-reduced-transparency` 实底 fallback。 |
| Bento（Apple 式瓷砖网格） | CSS Grid 混合 cell 尺寸。无单一库拥有它。 |
| Brutalism | 原生 CSS、等宽、生硬边框。无库。 |
| Editorial / 杂志 | 衬线、非对称网格、慷慨留白。无库。 |
| Dark tech / hacker | mono + 霓虹强调、终端母题。无库。 |
| Aurora / mesh 渐变 | SVG 或分层径向渐变。无库。 |
| Kinetic typography | 原生 CSS 动画、滚动驱动动画、GSAP hijack。无库。 |
| **Apple Liquid Glass** | Apple 仅为 Apple 平台记录此材质。**没有官方 `liquid-glass.css`**。Web 实现是用 `backdrop-filter` + 分层边框 + 高光的近似。明确标注为近似。（Web 近似 CSS 骨架见 `patterns.md` 的 Apple Liquid Glass 一节） |

---

## 3. 默认架构约定（未选真实系统时）

- **框架**：React / Next.js，默认 Server Components（RSC）。全局 state 只在 Client Component 生效；用 Motion/滚动监听/pointer 物理的组件必须是带 `'use client'` 的隔离叶子。
- **样式**：Tailwind v4（默认）。v4 不用 `tailwindcss` PostCSS 插件，用 `@tailwindcss/postcss` 或 Vite 插件。
- **动画**：Motion（原 Framer Motion），`import { motion } from "motion/react"`。
- **state**：局部 `useState`/`useReducer`；全局仅为避免深 prop 钻透用 Zustand/Jotai/context。**绝不用 `useState` 追连续值**（鼠标位置、滚动进度、pointer 物理）——用 Motion 的 `useMotionValue`/`useTransform`/`useScroll`。
- **图标**：优先 `@phosphor-icons/react`、`hugeicons-react`、`@radix-ui/react-icons`、`@tabler/icons-react`。不鼓励 `lucide-react`（除非用户明确要或项目已依赖）。**绝不手搓 SVG 图标路径**。一个项目一个图标家族，全局统一 `strokeWidth`。
- **响应式**：断点 `sm640 md768 lg1024 xl1280 2xl1536`；页面容器 `max-w-[1400px] mx-auto`；hero 用 `min-h-[100dvh]` 绝不 `h-screen`（防移动端地址栏跳动）；用 Grid 别用 flexbox 百分比数学（`w-[calc(33%-1rem)]`）。
- **依赖核验**：导入任何三方库前查 `package.json`；缺失就先输出安装命令，绝不假设库存在。

---

## 附录 A · 各设计系统安装命令

```bash
# Material Web (Material 3)
npm install @material/web
# Fluent UI React (v9)
npm install @fluentui/react-components
# Fluent UI Web Components（无框架）
npm install @fluentui/web-components @fluentui/tokens
# IBM Carbon
npm install @carbon/react @carbon/styles
# Radix Themes
npm install @radix-ui/themes
# shadcn/ui（开放代码，自有组件）
npx shadcn@latest init
npx shadcn@latest add button card badge separator input
# Primer CSS（GitHub 产品/开发工具 UI）
npm install --save @primer/css
# Primer Brand（GitHub 营销 UI）
npm install @primer/react-brand
# GOV.UK Frontend
npm install govuk-frontend
# USWDS（美国政务）
npm install uswds
# Atlassian（Atlaskit）
yarn add @atlaskit/css-reset @atlaskit/tokens @atlaskit/button @atlaskit/badge
# Bootstrap 5.3
npm install bootstrap
# Shopify Polaris Web Components（仅 Shopify app）—在 app HTML head 加：
#   <meta name="shopify-api-key" content="%SHOPIFY_API_KEY%" />
#   <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
```

## 附录 B · 官方文档锚点（重造轮子前先读）

- **Material Web**：material-web.dev/theming/material-theming · m3.material.io/develop/web
- **Fluent UI**：fluent2.microsoft.design/components/web/react · learn.microsoft.com/fluent-ui/web-components
- **Carbon**：carbondesignsystem.com · carbondesignsystem.com/developing/react-tutorial/overview
- **Shopify Polaris**：shopify.dev/docs/api/app-home/web-components · polaris-react.shopify.com/components
- **Atlassian**：atlassian.design/get-started/develop · atlassian.design/tokens/design-tokens
- **Primer**：primer.style · github.com/primer/css · github.com/primer/brand
- **GOV.UK**：design-system.service.gov.uk/components · github.com/alphagov/govuk-frontend
- **USWDS**：designsystem.digital.gov/components · designsystem.digital.gov/documentation/developers
- **Bootstrap**：getbootstrap.com/docs/5.3/layout/grid
- **Tailwind**：tailwindcss.com/docs/dark-mode · tailwindcss.com/blog/tailwindcss-v4
- **Radix**：radix-ui.com/themes/docs/components/theme
- **shadcn/ui**：ui.shadcn.com/docs
- **原生 CSS / W3C**：MDN backdrop-filter · prefers-color-scheme · prefers-reduced-motion · Grid layout · Scroll-driven animations · drafts.csswg.org/scroll-animations-1
- **Apple Liquid Glass（仅 Apple 平台）**：developer.apple.com/design/human-interface-guidelines/materials · developer.apple.com/documentation/TechnologyOverviews/liquid-glass

> 内容依据网络公开的官方文档整理，已改写以符合许可要求。安装命令与文档链接是现实锚点；发具体版本行为前请以对应系统官方文档为准。
