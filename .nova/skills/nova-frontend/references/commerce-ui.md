# Commerce UI — PDP / PLP / 购物车 / 结账

> **中文说明**：commerce register 的混合态规则——按页面任务分流：PDP 偏 brand，PLP/购物车/结账偏 product。
> **何时加载**：register=commerce 时；商品详情、列表、购物车、结账流程。
> **核心**：拿不准问一句"卖一个产品的氛围，还是比较筛选很多个？"；反暗黑模式禁令是 hard gate。

---

## 1. Register 分流

Commerce 是 **brand + product 混合态**，按具体页面任务路由，不要对整个 flow 套单一 register：

| 页面 | 倾向 | Dial 参考 |
|------|------|-----------|
| **PDP**（单 hero 商品） | brand：可挑灵魂，但保持规格/评价/信任信号高密度 | SOUL 6 / SPECTACLE 4 / DENSITY 6 |
| **PLP**（多 SKU 列表/分类） | product：高密度、低 spectacle | SOUL 3 / SPECTACLE 2 / DENSITY 8 |
| **购物车 / 结账** | product：信任与任务完成 | SOUL 3–4 / SPECTACLE 1–2 / DENSITY 7–8 |

**拿不准就问一句**："这页是卖一个产品的氛围，还是比较筛选很多个？"

无论哪条路径，都继承 substrate（`design-dna.md`）与反廉价黑名单（`anti-cheap.md`）。PDP 仍赚灵魂；checkout 赚信任而非 spectacle。

PDP 视觉灵魂见 `style-personas.md`；表单/表对齐见 `product-ui.md`。

---

## 2. Product Detail Page（PDP）

**标准布局**：gallery（左/移动在上）+ info column（右/移动在下）——桌面 info column 滚过 fold 后 sticky。

### Gallery
- 缩略图 rail + 主图；桌面 hover zoom、移动 pinch/tap。
- 视频、360°/AR 是**附加**，不替代静态图。
- 每张图有真实 alt（材质、角度、"worn by model"，不是 "product-image-3"）。

### 规格与变体
- **Color swatches**：显示真实色块，hover/focus 有名称，**禁止 color-only**（必须配对名称）。
- **Size**：≤8 选项用 button grid，不是 dropdown。
- **缺货变体**：可见但 disabled（删除线或 dimmed），**禁止移除**——移除会隐藏该尺码曾存在。

### 价格与 CTA
- 现价最大/最粗；若有删除线原价，两者必须真实（见 §6），折扣写事实（"20% off"，不只靠删除线暗示）。
- **一个视觉 dominant 主 CTA**："Add to cart" / "Buy now"。若两者并存，一 primary 一 secondary，禁止等权重双按钮。
- 滚过原 CTA 位置后 **sticky**（移动 bottom bar，桌面右列）。

### 信任栈（CTA 正下/旁）
- 运费估算、退货窗口、库存诚实线（"in stock, ships in 2 days" 或真实低库存数）。
- 见 §6 禁止 fabricated 紧迫信号。

### Fold 以下
- 规格表（复用 `product-ui.md` 表对齐：数字右对齐）。
- 评价（真实 1–5 星分布 histogram，不只圆整平均分）。
- Cross-sell（"goes with" / "customers also bought"）——是推荐，不是与主 CTA 竞争的第二 CTA。

---

## 3. Listing / Category Page（PLP）

Product register 规则直接适用（`product-ui.md` §1–2）——PLP 是穿 grid 的数据表。

- **Grid**：`repeat(auto-fill, minmax(220px, 1fr))`（区间 200–260px）；图片统一 aspect ratio（crop，不 stretch）。
- **Card 内容**：图、名、价、一个 key differentiator（评分或 swatch 数），不是完整 spec sheet。
- **Filters**：桌面左 rail / 移动 bottom-sheet 或 top drawer；显示 active filter count + 一键 "clear all"；实时结果数（"142 results"）；禁止 filter 返回零且无解释。
- **Sort**：显式 dropdown（relevance / price / rating / newest）——filter 时 silent 改 sort 是 bug。
- **Card CTA 底对齐**：同 `product-ui.md` §9 card grid 规则，价与 "add to cart" 跨行对齐。
- **分页 vs 无限滚**：无限滚需可见 "loaded N of M" + 可达 footer（"back to top"）；永远藏 footer 的无限滚是投诉源，不是 feature。
- **零结果**：禁止空白 grid——"no results for {filters}" + 一键 reset；可能的话 "closest matches" fallback。

---

## 4. 购物车

- **Line item**：缩略图 + 名 + variant（color/size）+ quantity stepper + line price + remove。
- **Quantity 变更与 price 更新无整页 reload**。
- **Summary 常驻**：subtotal 始终可见（列表长则 sticky）；shipping/tax 未知时写 "calculated at checkout"，**禁止静默省略**。
- **就地编辑**：quantity、variant swap、remove 都在 cart 完成；简单改数量禁止 detour 回 PDP。
- **空 cart**：有构图（非空白页）——回浏览路由，可选 recently-viewed。

---

## 5. 结账

- **分步，不是一堵墙**：shipping → payment → review；可见 step indicator；可返回且不丢已填数据。
- 全程遵循 `product-ui.md` §5 表单规则（label 在上、blur 校验、错误在下含修法）。
- **Guest checkout 可用**，除非产品有明确理由要求账户；账户提供放在下单**之后**，不是之前 gate。
- **首屏起成本透明**：shipping、tax、任何 fee 在最终支付步之前可见， ideally 从 checkout 开始 summary 就显示——见 §6 drip pricing 禁令。
- **Payment fields**：native `autocomplete`（`cc-number`、`cc-exp`、`cc-csc`）+ `inputmode="numeric"`；card-brand 图标只显示接受的品牌；错误 inline 每字段，不是单一 "payment failed" toast。
- **Order confirmation**：订单号、明细 summary、送达估算、收据路径（email 确认）on-screen——flow 最高信任时刻，禁止 bare "Thank you"。

---

## 6. 信任与转化元素（诚实使用）

- **Reviews**：真实分布 histogram 胜过 lone average；有数据则 verified-purchase tag。
- **Stock/urgency**：只反映真实库存或真实时间窗（fabricated 版见 §7 禁令）。
- **Trust badges**（secure checkout、return policy、payment logos）：小、CTA fold 以下，**禁止比 CTA 还大**——支持购买决策，不替代产品信息。
- **Comparison table**（多 tier 产品）：复用 `product-ui.md` §9 定价表 baseline——feature 行跨列 Y 对齐。

---

## 7. 反暗黑模式禁令 — `[HARD BAN]`

Commerce 专属绝对禁令。侵蚀信任，多国法律可诉：

- **假 countdown timer** 刷新重置或无真实 deadline → 只有真实、会过期的 offer 才用 countdown。
- **Fabricated 低库存/需求**（"only 2 left!"、"14 people viewing this"）无真实数据 → 显示真实库存或 omit。
- **Pre-checked add-ons / insurance / upsells** at checkout → opt-in，默认 unchecked。
- **Drip pricing**——shipping/fee/tax 藏到最后一步 → 从 checkout 第一屏起 total cost 可见。
- **Forced account creation** before purchase → guest checkout，账户 offer 在之后。
- **Confirmshaming**（"No thanks, I don't like saving money" 作 decline）→ 中性、尊重的 decline copy。
- **Hidden/buried unsubscribe/cancel**（PDP 卖的 subscription）→ 取消与注册一样容易，account settings 可找。
- **删除线价 +  inflated/从未真实的 "original" price** → 删除线价必须曾被实际收取。
- **Hard-to-close、action-disguised-as-close popups**（X 实际 add to cart 或 opt in）→ close 只做一件事：close。

---

## 8. Commerce Pre-Flight

- [ ] PDP：gallery 有真实 alt；变体 in/out of stock 全可见；一个 primary CTA；scroll sticky CTA；trust stack 诚实（无 fabricated urgency/stock）。
- [ ] PLP：filter 实时结果数 + 一键 clear；sort 显式；card CTA 底对齐；零结果有构图。
- [ ] Cart：quantity/variant 就地改无 full reload；subtotal 始终可见；空状态有构图。
- [ ] Checkout：最终支付前 full cost 可见；guest checkout；step indicator + 返回保数据；payment 字段正确 `autocomplete`/`inputmode`。
- [ ] §7 反暗黑模式清单逐项 absent——hard gate。
- [ ] 仍过 substrate + 反廉价黑名单（`anti-cheap.md`）。

完整清单见 `preflight.md`。
