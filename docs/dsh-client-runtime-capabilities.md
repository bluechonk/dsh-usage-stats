# DSH Web 客户端插件运行时能力调研报告

> **本文性质**：对 **DSH 宿主本身**的能力调研，不是本插件的实现说明。内容随宿主版本走，与本仓库的改版无关；宿主升级后需重新核对标注的版本号。
>
> **调研动机**：本插件（`@bluechonk/dsh-usage-stats`）要在设置页渲染「使用统计」看板（热力图 / 折线 / 环形图全部手绘 SVG），必须先摸清宿主提供什么——尤其是「有没有现成图表库」（结论：没有）与「CSS 变量怎么取」（结论：只用 `--dsw-alias-*`）。
>
> **对本仓库的直接影响**：
> - 图表全部自绘 SVG，故 `lib/client.js` 零第三方依赖；
> - 样式用自有的 `--dus-*` 变量表（挂在 `body` / `body[data-ds-dark-theme]` 两档）跟随宿主主题；
> - 面板注册在 `settings.section`（`order: 13`），标题与副题自己画（宿主不给 section 页头）。

调研对象：`C:\Users\bluechonk\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（版本 `0.2.1-rc.2`）
下文所有路径均相对 `app.asar` 根目录。

---

## 结论速览

| 问题 | 一句话结论 |
| --- | --- |
| 1 slots API | `ctx.slots` 是 Cordis Service `SlotRegistry`，实现类在 `dsh-client-ui-renderer/lib/client.js`；纯内核 `SlotCore` 只编译进前端 bundle，**未以包形式随 asar 发布** |
| 2 settings 面板 | 面板宽 800px，左侧 188px 导航栏；`settings.section` 内容区**无宿主页头标题、无宽度限制**，标题需自己画；同 section 多页签需自己实现（参考 Plugins 分区） |
| 3 CSS 变量 | 403 个 `--dsw-*`，全部来自 `dsh-client-ui-theme`；亮暗**变量名完全一致**，只换值（`body` vs `body[data-ds-dark-theme]`）；**没有间距变量、没有 z-index 变量** |
| 4 模块表 | 静态基线表只有 11 个 id；**无任何图表库 / 日期库 / clsx**（clsx 是内联进各 bundle 的，不是模块条目） |
| 5 宿主服务 | client 侧直接有 `ctx.sessions`（会话列表）、`ctx.workspaces`（工作区列表）、`ctx.remote.session.*` RPC；`sessionQuery` / `workspaceRegistry` / `tokenMeter` / `webServer` 仅 host 半可用 |
| 6 用量 UI | **没有**现成的用量统计面板 / 热力图 / 趋势图；可复用的是 `ContextMeter`（SVG 环图）、`UsagePill`、`TurnUsagePanel`、`deriveTurnTokenUsage` |
| 7 图标 | `@deepseek-ai/dsh-client-ui-primitives` 内置 **188 个 `Icon*` 组件**（静态模块表内可直接 require），外加 101 个通用 UI 原语 |

---

## 1. slots API 完整接口

### 1.1 服务与内核的位置（重要）

- **服务层 `ctx.slots`** = `SlotRegistry`（Cordis `Service` 子类）
  - `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1305` `var SlotRegistry = class extends _deepseek_ai_cordis.Service {`
  - `.../dsh-client-ui-renderer/lib/client.js:1348` `super(ctx, "slots");`
  - 安装点：`.../dsh-client-ui-renderer/lib/client.js:1867-1875` `apply(ctx)` → `new SlotRegistry(ctx).install(createSlotRenderer())`

- **纯内核 `@deepseek-ai/dsh-client-ui-slots`**（`SlotCore` 等）
  - **asar 内没有 `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots` 这个目录**（`ls-header.cjs` 全量扫描确认）。
  - 它被编译进前端 shell bundle：`dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（偏移 ≈ 485000–495000），导出：
    `SlotCore, SlotOwnershipError, StaleAuthorizationError, resolveSlotLabel, standardHookPropName`
  - 结论：社区插件**可以 `require("@deepseek-ai/dsh-client-ui-slots")`**（它在静态模块表里），但拿不到源码文件。

### 1.2 `ctx.slots` 服务方法全表

来源：`.../dsh-client-ui-renderer/lib/client.js`

| 方法 | 行号 | 说明 |
| --- | --- | --- |
| `inject(key, callback)` | 1368 | **等待某个 slot 被声明**再执行 callback；slot 已声明则同步执行；返回幂等 disposer；属调用方 fiber，插件卸载自动清理 |
| `register(options, component)` | 1813 | 注册一个 slot 条目，返回 disposer |
| `registerFactory(options, component)` | 1817 | 注册一个可复用 Component Factory |
| `entries(key)` | 1542 | 原始条目列表（检查用） |
| `entriesOfSlot(key)` | 1554 | 每个 cell 的"胜出者"（渲染实际使用的） |
| `snapshot(root?)` | 1562 | 导出 JSON-safe 的 slot/factory 声明树 |
| `spec(key)` | 1582 | 查询已声明的 spec |
| `subscribe(key, fn)` | 1591 | 订阅注册变更（microtask 批处理） |
| `getVersion(key)` | 1599 | uSES 配对用的版本号 |
| `onEntryError(fn)` | 1574 | 统一观察条目崩溃 |
| `install(renderer)` | 1434 | 安装渲染器（boot-once，重复调用抛错） |
| `installLocale(face)` | 1450 | 安装 locale 面（boot-once） |
| `installScope(scope, adapter)` | 1491 | 安装作用域适配器（`session` / `session-maybe`） |
| `provideRoot(contribution)` | 1465 | 贡献 root 级标准数据：`{ hooks, keyedHooks, props }` |
| `bindStoreScope(binding)` | 1512 | 绑定 store 实例到某个 Context 代 |
| `renderSlot(key, owner)` | 1531 | **ctx 级唯一渲染入口，只允许 `"root"`**；其它 key 走组件 props 的 `renderSlot` 面 |

### 1.3 `slots.register(descriptor, Component)` 的 descriptor 字段

内核解析在 bundle 的 `SlotCore.register`（`index-CN7NIWNw.js` 偏移 ≈ 489500–492500），服务层透传在 `.../dsh-client-ui-renderer/lib/client.js:1603-1623`（`_register`）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | ✅ | slot 名，必须已被某条目的 `children` 声明（`root` 为内建） |
| `key` | string | key 槽必填 | `kind:"keyed"` 的键 |
| `id` | string | list 槽必填 | `kind:"list"` 的条目 id；**同 id 重复注册会抛错**（除非 priority 不同 → 遮蔽） |
| `order` | number | — | `kind:"list"` 内排序（先按 `priority` 再按 `order`） |
| `priority` | number | — | 遮蔽优先级，**数值小者胜出并先渲染**；同槽同 priority 重复注册抛错 |
| `label` | string \| () => string | — | **两种都支持**；`resolveSlotLabel` 遇到函数会调用它取返回值 |
| `select` | (ownerProps) => any | chain 槽必填 | chain 选举函数，返回非 null 即当选 |
| `inject` | () => ({ hooks, ...plainProps }) | — | `hooks` 里的每个 key 变成 `use<Key>` 选择器 Hook prop；其余键变成普通 prop |
| `children` | { [slotName]: { kind, scope, inline } } | — | **声明子槽**（嵌套能力） |
| `store` | store handle | — | 绑定 store（root/session 实例轴） |
| `locale` | string | — | locale 命名空间；组件会额外拿到 `t` prop |
| `registrant` | string | — | 登记人标签，默认取当前 fiber 名 |

**槽 kind（4 种）**：`single`（唯一）、`keyed`（按 `key`）、`list`（按 `id`，可多条）、`chain`（选举）。
**作用域 scope（3 种）**：`root`、`session`、`session-maybe`（无会话时先空壳、会话到来后"收养"首个会话）。

### 1.4 组件能拿到什么 props

由 renderer 的 standard kit 组装（`.../dsh-client-ui-renderer/lib/client.js:736-767`）：

- `renderSlot(key, ownerProps, opts)` — 渲染**自己声明过的子槽**；`opts.only` 按 id 过滤（renderer `:1219`）、`opts.fallback`、`opts.entryKey`（keyed）、`opts.fallbackOnly`、`opts.overlay`、`opts.hookContext`
- `renderSlotChain(key, ...)` — 子槽里存在 chain 时才注入
- `renderFactorySlot(name, props, opts)` — 渲染 Factory
- `SessionProvider` — 声明了非 root 子槽时注入
- `useStore` / `actions` — 绑定 store 时注入
- `t` — 声明了 `locale` 时注入（`localeSeat`）
- root 级标准 Hook：`useSessions`（`dsh-client-ui-session/lib/client.js:1104`）、`useWorkspaces`（`dsh-client-ui-workspace/lib/client.js:5039`）、`usePanelInfo`（`dsh-client-ui-layout/lib/client.js:621`）
- session 级标准 Hook（`dsh-cordis-client-runner/lib/client.js:2460` 附近）：`useSessions / useSession / useSessionStatus / useSessionRetainInfo / useSessionAccess / useWorkspaceAccess / useChat / useConversation / useInput / inputActions / useProjection / useAccess / useTrajectory / usePanelInfo`

### 1.5 嵌套 section 与"同 section 多页签"

- **嵌套 section：支持。** 通过条目的 `children` 声明子槽，组件内用 `renderSlot(childKey, props)` 渲染。
  典型例子：`settings.section` 的 `general` 条目声明 `children: { "settings.general.item": { kind: "list", scope: "root" } }`
  （`.../dsh-client-ui-settings-general/lib/client.js:1293-1303`），GeneralSection 内 `renderSlot("settings.general.item", {})`（`:635-639`）。

- **同一 section 内多个页签：不原生支持，必须自己实现。** 宿主的 `settings.section` 是 `kind:"list"`，但 shell 一次只渲染 `only: active` 的那一个（`.../dsh-client-ui-settings-general/lib/client.js:337`）。
  官方"Plugins 分区多页签"是这样做的（`.../dsh-client-ui-settings-plugins/lib/client.js`）：
  1. section 条目声明子槽 `children: { "settings.plugins.tab": { kind: "list", scope: "root" } }`（`:208`）
  2. section 组件自己读 `ctx.slots.entries("settings.plugins.tab")` 拿 `{id, order, label}` 列表（`:178-193`）
  3. 自己渲染 tab 按钮条，再 `renderSlot("settings.plugins.tab", {}, { only: row.id })`（`:124`）

---

## 2. settings 面板渲染

宿主 shell 在 `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`。

### 2.1 版面与尺寸（CSS 在同文件 `:60` 的 `SettingsRoot.module.css`）

| 元素 | 尺寸 / 样式 |
| --- | --- |
| 遮罩 `.overlay` | `position:fixed; inset:0; z-index:1000; display:flex; justify-content:center; align-items:center` |
| 面板 `.panel` | `width:800px; max-width:calc(100vw - 48px); height:min(800px, calc(100vh - 2*max(24px, var(--dsh-frame-overlay-top,24px)))); border-radius:var(--dsw-radius-panel); background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-elevation-prominent); display:flex` |
| 左导航 `.nav` | `width:188px; padding:22px 12px 0; gap:18px` |
| 导航标题 `.navTitle` | 16px/500；**内容来自 `settings.header` 槽**，同时是 dialog 的 `aria-labelledby` 目标（`:277` `titleId`，`:295-303`） |
| 导航项 `.navCell` | 高 40px，圆角 `--dsw-radius-md`，图标由 `navIcon(id)` 按 section id 猜（`:244-269`） |
| 顶部行 `.header` | `height:54px; padding:20px 14px 8px 10px`；右侧是 `settings.action` 槽 + 关闭按钮（关闭按钮的隐藏 label 来自 `settings.close` 槽） |
| 内容区 `.options` | `flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto` |

### 2.2 关键结论

- **宿主页头标题：只提供"对话框标题"（`settings.header`，位于左导航顶部），不提供 section 页头。**
- **section 内容区无宽度限制**，宽度由 section 自己定；官方 Plugins section 自定 `max-width:760px`（`.../dsh-client-ui-settings-plugins/lib/client.js:11`）。
- **section 必须自己画标题**（官方做法：`.amjGKq_heading{font-size:18px;font-weight:600}` + `.amjGKq_intro` 说明文字，同上 `:11`）。
- `settings.section` 的 owner props = `{ close: onClose }`（`:337`），所以 section 组件能拿到关闭回调。
- 渲染参数：`renderSlot("settings.section", { close: onClose }, { only: active })` —— `active` 是当前选中的 section id。
- 左侧导航行的 `{ id, order, label }` 由宿主从 `ctx.slots.entries("settings.section")` 现算（`:1145-1150`），`label` 用 `resolveSlotLabel(e.options.label)` 解析 → **label 传函数或字符串都行**。

### 2.3 `dsh-client-ui-settings*` 相关包的**全部** slot 名称

| slot 名 | 声明方（包） | kind / scope | 提供方（注册方） |
| --- | --- | --- | --- |
| `settings.launcher` | ui-settings-general `:1238` | single / root | ui-settings-account `:4768` |
| `settings.trigger` | ui-settings-general `:1242` | single / root | ui-settings-general `:1274` |
| `settings.header` | ui-settings-general `:1246` | single / root | ui-settings-general `:1278` |
| `settings.action` | ui-settings-general `:1250` | **list** / root | ui-settings-general `:1282`（id `open-document`） |
| `settings.close` | ui-settings-general `:1254` | single / root | ui-settings-general `:1289` |
| **`settings.section`** | ui-settings-general `:1258` | **list** / root | ui-settings-general `:1293`（id `general`, order 0）、ui-settings-models `:4485`（id `models`, order 10）、ui-settings-plugins `:201`（id `plugins`, order 15）、ui-agent-preset `:2455`（id `agent-presets`, order 20）、ui-settings-account `:4776`（id `account`，条件注册） |
| `settings.onboarding` | ui-settings-general `:1262` | list / root | ui-settings-models `:4502`（id `welcome-notice`）、`:4508`（id `deepseek-official`） |
| `settings.general.item` | ui-settings-general `:1299` | list / root | ui-settings-general `:1079`（`developer-tools`）、`:1089`（`current-version`）、ui-theme `:2046/:2054`、ui-shortcuts `:1086`、ui-chat `:13129/:13164/:13176`、ui-conversation `:19543`、ui-permission-presets `:796`、ui-settings-session-log `:159` |
| `settings.plugins.tab` | ui-settings-plugins `:208` | list / root | ui-settings-plugin-inventory `:757`（id `all`, order 10）、ui-settings-shell `:182`、ui-settings-agent-loop `:158`、ui-settings-subagent `:839`、ui-settings-web-search `:510`（这四个注册在 `plugins.item`） |
| `settings.models.provider-card` | ui-settings-models `:4492` | — | — |
| `settings.models.footer` | ui-settings-models `:4496` | — | — |
| `settings.models.sign-in` | ui-settings-models `:4511` | — | ui-settings-account `:4741` |
| `shell.quota-notice` | ui-settings-account | single | ui-settings-account `:4746`（配额提示条，可参考） |

**不存在** `settings.page` / `settings.row` / `settings.field` 这些名字。最接近的替代是：
`settings.general.item`（通用分区的行级列表）与 `settings.plugins.tab`（分区内的页签列表）。

---

## 3. 可用 CSS 变量（`--dsw-*`）

### 3.1 来源与机制

- 全部来自 `dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（8 张样式表：`base.css / corner-shape.css / design-platform.css / focus.css / onboarding.css / scrollbar.css / gradient-shadow-text.css / shiki.css`）。
- 共 **403 个** `--dsw-*` 变量。
- **亮暗变量名完全一致**，只换值：
  - 浅色：`body { --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00); ... }`
  - 深色：`body[data-ds-dark-theme] { --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950); ... }`
  - 深色标记由宿主在 `<body>` 上设置（`data-ds-dark-theme`），插件**不要**自己去切。
- 另有 `--dsh-*` 运行时变量（用户字号/字体）：`--dsh-content-font-size`、`--dsh-content-font-delta`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta-secondary`、`--dsh-code-font-delta`、`--dsh-code-font-size`、`--dsh-terminal-font-size`、`--dsh-font-family-text`、`--dsh-font-family-code`、`--dsh-font-family-text-default`、`--dsh-font-family-code-default`、`--dsh-scrollbar-width`、`--dsh-scrollbar-thumb`、`--dsh-scrollbar-thumb-hover`、`--dsh-scrollbar-thumb-border`、`--dsh-scrollbar-track-margin`。
- ⚠️ **没有间距（spacing/gap/padding）变量，也没有 z-index 变量**。所有组件间距都是字面 px，`z-index` 也是字面值（如设置遮罩写死 `z-index:1000`）。写插件时需要自己定一套间距常量。

### 3.2 可直接写 CSS 的变量清单

#### 语义别名 `--dsw-alias-*`（117 个，强烈推荐只用这一层）

**背景层**
```
--dsw-alias-bg-base              页面底色
--dsw-alias-bg-layer-1           一级层（卡片/输入框底）
--dsw-alias-bg-layer-2           二级层（设置面板底）
--dsw-alias-bg-layer-3           三级层
--dsw-alias-bg-overlay           浮层/下拉底
--dsw-alias-bg-module-platform   平台模块底（徽标/开关轨）
--dsw-alias-bg-multi-select      多选底
--dsw-alias-bg-skeleton          骨架屏
--dsw-alias-bg-document-preview 文档预览底
--dsw-alias-bg-document-selection 文档选区（两主题同值，blue-500 40%）
--dsw-alias-bg-mask-1 / -2 / -3 / -photo / -drop   遮罩层
```

**文字标签**
```
--dsw-alias-label-primary         主文字
--dsw-alias-label-secondary       次文字
--dsw-alias-label-tertiary        三级文字（说明/占位）
--dsw-alias-label-caption         极小注脚
--dsw-alias-label-dimmed          弱化文字
--dsw-alias-label-primary-dimmed  主文字弱化变体
--dsw-alias-label-primary-bluish  主文字蓝调变体
--dsw-alias-label-primary-foreground  主色按钮上的前景
--dsw-alias-label-primary-inverted   反色主文字
--dsw-alias-label-document-preview    文档区文字
--dsw-alias-label-shimmer         文字扫光叠加
--dsw-alias-label-deep-diving     深潜蓝（活动态文字）
--dsw-alias-label-deep-diving-shimmer
--dsw-alias-menu-icon             菜单图标色
--dsw-alias-link                  链接色
```

**边框**
```
--dsw-alias-border-l1   最浅分隔线（浅 #0000000a / 深 #ffffff0f）
--dsw-alias-border-l2   常规分隔线（浅 #0000001a / 深 #ffffff1f）
--dsw-alias-border-l2-darkmode-thin  深色细线变体
--dsw-alias-border-l3   强分隔线
--dsw-alias-border-l4   最强描边（设置卡片描边）
--dsw-alias-border-inverted / -inverted2  反色边框
```

**品牌色**
```
--dsw-alias-brand-primary        主品牌色
--dsw-alias-brand-text           品牌文字色
--dsw-alias-brand-primary-invert 品牌色反相
--dsw-alias-brand-primary-new-colorprimary-new-color  新品牌蓝（#4176e6 / #7aaaff）
```

**语义状态色（成功/警告/错误 —— 有！）**
```
--dsw-alias-state-success-primary / -secondary / -tertiary
--dsw-alias-state-warn-primary    / -secondary / -tertiary / -label
--dsw-alias-state-error-primary   / -secondary
--dsw-alias-state-idle-primary
--dsw-alias-state-business-primary / -tertiary   （业务蓝）
--dsw-alias-interactive-bg-hover-danger           （危险态悬停底）
```

**交互态**
```
--dsw-alias-interactive-bg-hover        悬停底
--dsw-alias-interactive-bg-hover-accent 强调悬停
--dsw-alias-interactive-bg-hover-solid  实体悬停
--dsw-alias-interactive-bg-hover-danger 危险悬停
--dsw-alias-interactive-bg-active       按下态
```

**按钮**
```
--dsw-alias-button-primary-fill / -hover / -dimmed
--dsw-alias-button-contrast-fill
--dsw-alias-button-elevated-fill
--dsw-alias-button-floating-fill / -hover
--dsw-alias-button-ghost-active-fill / -hover / -border
--dsw-alias-button-info-fill / -hover
--dsw-alias-button-tool-bar-fill / -hover / -invisible
```

**卡片 / 菜单 / 浮层 / 提示**
```
--dsw-alias-settings-card-fill     设置卡片底 (= bg-layer-2)
--dsw-alias-settings-card-stroke   设置卡片描边 (= border-l4)
--dsw-alias-menu-group-header-fill 吸顶分组标题底（94% 不透明）
--dsw-alias-toast-bg / -label      系统提示
--dsw-alias-tooltip-bg / --dsw-alias-tooltip-key-bg
--dsw-alias-switch-thumb            开关滑块
--dsw-alias-scrollbar-bg-l1 / -l2, --dsw-alias-scrollbar-hover-l1 / -l2
```

**代码差异 / Markdown**
```
--dsw-alias-code-diff-added / -deleted
--dsw-alias-file-diff-added-bg / -gutter / -marker
--dsw-alias-file-diff-deleted-bg / -gutter / -marker
--dsw-alias-markdown-code-block / -banner / -inline-code / -placeholder / -tag / -citation
--dsw-alias-markdown-code-segment-selected / -unselected
```

**引导页**
```
--dsw-alias-onboarding-accent / -card-fill / -secondary-fill / -checkbox-border
```

#### 圆角 `--dsw-radius-*`
```
--dsw-radius-xs     4px
--dsw-radius-sm     8px
--dsw-radius-md     12px
--dsw-radius-lg     16px
--dsw-radius-xl     20px
--dsw-radius-panel  28px   （设置面板）
--dsw-corner-shape  superellipse(1.5)（Chrome 支持时圆角变超椭圆）
```

#### 阴影 / 层级
```
--dsw-shadow-lv1        0 2px 4px 0 #0000000d
--dsw-shadow-lv1-blur   0 4px 12px 0 #00000005
--dsw-shadow-lv2        0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a
--dsw-shadow-lv3        0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014
--dsw-elevation-stroke       0 0 0 .5px var(--dsw-elevation-stroke-color)
--dsw-elevation-stroke-color (可重绑，默认 border-l4 / border-l3)
--dsw-elevation-soft         描边 + 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008
--dsw-elevation-panel        描边 + 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005
--dsw-elevation-prominent    描边 + 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d
--dsw-mask-blur              none
--dsw-menu-backdrop-filter   blur(40px) saturate(150%)
```

#### 字号 `--dsw-font-*`
```
--dsw-font-family            正文族（var(--dsh-font-family-text) + 默认栈）
--dsw-font-family-brand      Montserrat（品牌字）
--dsw-font-xxxs-11 / -strong-11   11px/14px
--dsw-font-xxs-12  / -strong-12   12px/18px
--dsw-font-xs-13   / -strong-13   13px/20px
--dsw-font-s-14    / -strong-14   14px/22px
--dsw-font-base-16 / -strong-16   16px/24px
--dsw-font-m-18                    16px/28px（500）
--dsw-font-l-20                    20px/28px（500）
--dsw-font-xl-24                   24px/32px（600）
--dsw-font-markdown-base / -h1 / -h2 / -h3 / -h4 / -small / -code / -code-block / -code-block-small / -table / -table-head
（每个都有配套 -font-size / -line-height / -font-weight / -font-family / -font-style 拆解变量）
```

#### 焦点环
```
--dsw-focus-ring-width   2px
--dsw-focus-ring-color   transparent（指针模态下故意透明）
焦点环颜色默认表达式：var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))
```

#### 静态色阶 `--dsw-static-*`（一般别直接用，但调色时可能要用）
```
neutral / neutral-bluish（00…1000 多档）、blue（50…950 + 50p/75/450）、deepseek（50…900）、green、red、amber
```

#### 渐变
```
--dsw-gradient-onboarding-violet-stops / -blue-stops / -cyan-stops
--dsw-linear-gradient-think / --dsw-linear-think-select
```

---

## 4. 模块表里有什么可 require

### 4.1 `window.__ModuleLoader__` 谁注入

- **host 侧**在 index HTML 的 `<head>` 里注入队列门面：`dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:463` `window.__ModuleLoader__={...}`，并注入 `window.__DSH_BOOT__` 图（`:501`）。
- **shell boot kernel** 调用 `r.create({ boot: window.__DSH_BOOT__, staticModules: SZ(), ... })`：
  `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（偏移 ≈918559）。
- 静态表被塞进 `ClientModuleSystem.seed`：`.../dsh-client-modules/lib/client.js:681` `this.seed = new Map(Object.entries(options.staticModules));`

### 4.2 静态基线表（`SZ()` 的返回值，index-CN7NIWNw.js 偏移 ≈916289）

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
zod
@tanstack/react-virtual
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

### 4.3 动态模块

任何**已启用**且带 `lib/client.js` 的 DSH 包都在 boot graph 里，模块 id = **包名**（如 `@deepseek-ai/dsh-client-ui-theme`）。
`/client` 后缀会被归一（`stripClientSuffix`，`.../dsh-client-modules/lib/client.js:98-100`），所以 `require("@deepseek-ai/dsh-api-gateway/client")` 与 `require("@deepseek-ai/dsh-api-gateway")` 等价。
包要进图必须在 `package.json` 里声明 `dsh.client`（示例：`.../dsh-client-ui-theme/package.json:30-43`）：
```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", ...], "immediately": true } }
```
`inject` 列表决定加载顺序（依赖先到）。

### 4.4 图表库 / 日期库 / clsx —— 结论

**全部没有。**

- asar 的 `dsh/node_modules` 全量扫描：**无** recharts / chart.js / d3 / visx / echarts / dayjs / date-fns / clsx / classnames / lucide-react。
- 两个前端 bundle（`index-CN7NIWNw.js`、`vendor-DcuzkuQH.js`）对这些关键字的命中数全为 0。
- 所有内置 client bundle 的 `require("...")` 全集只有：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`、`@deepseek-ai/dsh-api-gateway/client`。
- `clsx` 是**内联**进各 bundle 的（例：`.../dsh-client-ui-settings-general/lib/client.js:44-58` 的 `//#region ../../../node_modules/.pnpm/clsx@2.1.1/...`），**不是模块表条目** → 社区插件必须自己写一个 3 行 `cx()` 或用模板字符串。

### 4.5 require 语义（写插件必须知道）

`.../dsh-client-modules/lib/client.js:832-850`：
- `require(spec)` 是**同步**的，解析顺序：静态种子词 → 已物化模块 → 已注册 factory。
- 没到达的动态包**同步 require 会抛错**：`require("${spec}") missed the module table`。
- `require.async("./client.foo.js")` 用来取包内动态 chunk（文件名必须匹配 `client.<name>.js`）。
- factory 循环 require 会抛 `require cycle`（工厂式 CJS 不能交付半成品）。

---

## 5. client 能否直接访问宿主服务

### 5.1 client 半（浏览器插件树）里能注入的服务

| 服务 | 提供方 | 说明 |
| --- | --- | --- |
| `slots` | `dsh-client-ui-renderer/lib/client.js:1348` | 见第 1 节 |
| `locale` | dsh-client-locale | `ctx.locale.register(ns,{zh,en})` / `ctx.locale.bind(ns)` |
| `sessions` | `dsh-api-session-controller/lib/client.js:3840` `rootCtx.reflect.provide("sessions", this, void 0)` | **会话列表** |
| `workspaces` | `dsh-api-workspace-controller/lib/client.js:389` `super(ctx,"workspaces")` | **工作区列表** |
| `uiSession` / `uiWorkspace` / `uiConversation` | `dsh-client-ui-session/lib/client.js:798` / `dsh-client-ui-workspace/lib/client.js:1380` / `dsh-client-ui-conversation/lib/client.js:4041` | UI 层适配器 |
| `layout` | `dsh-client-ui-layout/lib/client.js:621` | 面板布局 |
| `theme` | dsh-client-ui-theme | 主题快照 |
| `shortcuts` | dsh-client-shortcuts | 快捷键目录 |
| `modules` | `dsh-client-modules/lib/client.js:1003` | 客户端模块系统 |
| `configForms` / `settingsSchema` | `dsh-client-ui-settings` | 设置文档镜像 + schema |
| `commands` / `commandUi` / `inputTriggers` | dsh-commands / ui-* | 命令与输入触发器 |
| `jobs` / `resources` / `feedbackUi` / `pluginNavigation` | 各自包 | |
| `connection` / `credentials` / `typert` | dsh-client-connection / dsh-typert-* | 连接与凭据 |
| `remote` + `remote.*` | dsh-client-connection | **宿主 RPC 命名空间**（见下） |
| `timer` | `dsh-cordis-client-runner/lib/client.js:7086` `super(ctx,"timer")` | 定时器（client 侧可用） |
| `loader` / `uiRenderer` / `cordisInspect` / `dynamicCordisRunner` | 各包 | |
| `sidebarRight` / `sidebarRightTabs` / `conversation` / `webTerminals` / `fileUpload` / `documentPreviews` / `chatFileMentions` / `storageDomain` / `appExit` / `appReady` | 各包 | |

### 5.2 会话 / 工作区数据源（client 侧确实有，不用自己搞 HTTP）

- **会话列表**：`ctx.sessions`
  - 快照形状 `{ byId: {...}, phase: "pending" | "ready" | ... }`（`.../dsh-api-session-controller/lib/client.js:3816-3817`）
  - 宿主通过控制帧把整张列表推下来（`:446` `projections: frame.projections`）
  - UI 侧用法：`ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })`（`.../dsh-client-ui-session/lib/client.js:1104`），组件里用 `useSessions(sel)`
- **工作区列表**：`ctx.workspaces` / `ctx.uiWorkspace`
  - `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })`（`.../dsh-client-ui-workspace/lib/client.js:5039`）
- **RPC**（`ctx.remote.*`，浏览器 → 宿主，走 WebSocket）：
  ```
  remote.session.list / .page / .search / .projections / .create / .control /
            .prompt / .rename / .cancel / .fork / .follow / .attachment /
            .modelCatalog / .updateQueue / .workspacePathApplications
  remote.workspace.follow
  remote.settings.describe / .mutate / .update / .openSettingsDocument
  remote.account.getBalance / .getProfile / .watch / .signOut / ...
  remote.job.*, remote.goals.*, remote.skills.*, remote.plan.* ...
  ```
  （枚举自所有 `client*.js` 的 `remote.<ns>.<method>` 调用）

### 5.3 只有 host 半才有的服务（client 拿不到）

| 服务 | 位置 |
| --- | --- |
| `sessionQuery` | `dsh-session-query/lib/index.js:1048` |
| `workspaceRegistry` | `dsh-workspace/lib/index.js:376` |
| `tokenMeter` | `dsh-token-meter/lib/index.js`（host 半，无 client.js） |
| `webServer` | `dsh-host-webserver/lib/index.js` |

### 5.4 HTTP 路由

- `ctx.webServer.register({ kind, path, ... })` 是 **host 侧** API（`dsh-host-webserver/lib/index.js:326`，重复 `(kind,path)` 抛错；`:495` 最长前缀匹配）。
- **纯 client 插件不能注册路由。**
- 但一个 DSH 插件包可以**同时有 host 半和 client 半**：`lib/index.js`（host，`apply(ctx)` 可 `ctx.webServer.register`）+ `lib/client.js`（浏览器 bundle）+ `package.json` 的 `dsh.client` 声明。这样就能自定义 `/api/xxx`。
- 结论：**优先用 `ctx.sessions` / `ctx.workspaces` / `ctx.remote.*`，不必自建 HTTP 路由**；只有需要跨会话聚合、宿主侧算力（如扫 SQLite 汇总 token）时才值得上 host 半 + `/api/xxx`。

---

## 6. 现有"用量统计 / token 统计" UI

### 6.1 结论：**没有**现成的用量统计面板、热力图、趋势图

- `dsh-client-ui-*` 全部包中检索 `heatmap` / `donut` / `conic-gradient` / 趋势图 —— **0 命中**。
- `dsh-token-meter` 包**没有 `lib/client.js`**（只有 `lib/types/client.js`，仅导出 `deriveTurnTokenUsage`），是纯 host 半。
- `dsh-session-stats` 同理，纯 host 半。

### 6.2 可复用的现成零件

| 零件 | 位置 | 说明 |
| --- | --- | --- |
| **`ContextMeter`（SVG 环形图 + 分段堆叠条）** | `dsh-client-ui-conversation/lib/client.js:18528-18650` | 纯内联 SVG（`<circle>` + `strokeDasharray`），读 `useProjection("contextPressure")` 与 `useProjection("contextBreakdown")`；**做 donut/环图可直接照抄这段** |
| `UsagePill` | `dsh-client-ui-chat/lib/client.js:7603-7639` | 会话 token 总量 + 缓存命中率胶囊，点开是 `<dl>` 明细（input / cacheRead / cacheWrite / output） |
| `ActivityPill` | `.../dsh-client-ui-chat/lib/client.js:7565-7601` | 轮次/步数/速度（LLM 时长、工具时长、TTFT、decode speed） |
| `DialogPill` / `PlainPill` | `.../dsh-client-ui-chat/lib/client.js:7516-7559` / `7498-7510` | 胶囊 + 弹层骨架，可直接复用样式 |
| `TurnUsagePanel` | `.../dsh-client-ui-chat/lib/client.js:7003` | 单轮用量面板 |
| `deriveTurnTokenUsage(events)` | `.../dsh-client-ui-chat/lib/client.js:10957`；也由 `@deepseek-ai/dsh-token-meter/client` 导出（`dsh-token-meter/lib/types/client.js:6`） | 客户端把一轮事件折叠成精确逐次尝试/整轮用量 |
| `useSessionStats` | `.../dsh-client-ui-chat/lib/client.js:7489-7493` | `useProjection("sessionStats")` 优先，否则本地 `deriveStats` 兜底 |

### 6.3 用量数据来源（3 条路）

1. **投影（推荐，实时）**：`useProjection("tokenUsage")` / `useProjection("contextPressure")` / `useProjection("contextBreakdown")` / `useProjection("sessionStats")`
   —— 宿主把投影值通过 Session Controller 控制帧推给浏览器（`dsh-api-session-controller/lib/client.js:446`、`:2241-2247`）。
   投影字段定义在 `dsh-token-meter/README.zh.md:49`：
   `tokenUsage = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`。
2. **RPC 拉取**：`ctx.remote.session.projections(...)` / `ctx.remote.session.list()` / `.page()` / `.search()`。
3. **宿主自己算**：host 半 `ctx.tokenMeter.measure(session)` → `{ totalTokens, surfaceTokens, nodes[] }`（`dsh-token-meter/README.zh.md:36-43`）；`ctx.tokenMeter.estimateMessage(message)`。
   ⚠️ 官方明确：这是**启发式估算**（每 token 四字符 + 角色开销），CJK 与 JSON schema 会严重低估，**不要当计费数据展示**（`dsh-token-meter/README.zh.md:140`、`:154`）。

---

## 7. 图标

### 7.1 结论：有内置图标组件，不需要内联 SVG

`@deepseek-ai/dsh-client-ui-primitives` 在静态模块表里，**导出 188 个 `Icon*` 组件**（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 偏移 ≈495000 后的 `zU` 导出对象；`dsh-client-ui-primitives` 包本身未随 asar 发布，只有 bundle）。

命名规律：`Icon<名称><样式>Medium|Regular`（`ICON_MEDIUM_STROKE` / `ICON_REGULAR_STROKE` 两种描边粗细）。
props：`size`（数字）、`className`。
用法示例（`.../dsh-client-ui-settings-general/lib/client.js:265-268`）：
```jsx
jsx(IconSettingsOutlineMedium, { className: navIcon, size: 16 })
```

常用图标举例：
`IconSettingsOutlineMedium` `IconUserOutlineMedium` `IconDataOutlineMedium` `IconDatabaseOutlineRegular` `IconGaugeOutlineRegular` `IconAgentPresetOutlineMedium` `IconPersonalizationOutlineMedium` `IconArchiveOutlineMedium` `IconCloseOutlineRegular` `IconDownloadOutlineRegular` `IconLoadingOutlineRegular` `IconChevronDownOutlineRegular` `IconChevronUpOutlineRegular` `IconChevronLeft/RightOutlineRegular` `IconSearchOutlineRegular` `IconPlusOutlineRegular` `IconTrashOutlineRegular` `IconCopyOutlineRegular` `IconRefreshOutlineRegular` `IconCodeOutlineRegular` `IconGlobeOutlineRegular` `IconLightOutlineRegular` `IconDarkOutlineRegular` `IconFollowsystemOutlineRegular` `IconWarningTriangleOutlineRegular` `IconSparkleRegular` `IconPlayOutlineRegular` `IconPauseOutlineRegular` `IconStopFillRegular` `IconSendOutlineRegular` `IconQueueOutlineRegular` `IconSlidersTwoOutlineRegular` `IconGoalOutlineRegular` `IconPlanOutlineRegular` `IconTreeCornerRegular` `IconWorkspaceTreeOutlineRegular` `IconSkillOutlineRegular` `IconShieldOutlineRegular` `IconCompareSplitOutlineRegular` `IconContextInjectionOutlineRegular` `IconCordisPluginOutlineRegular` `IconPluginPinwheelOutlineRegular` `IconCheckCircleOutlineMedium` `IconCheckCircleFillMedium` `IconDislikeOutlineMedium` `IconLikeOutlineMedium` `IconInfoOutlineMedium` `IconQuestionOutlineRegular` `IconEllipsisOutlineRegular` `IconFullscreenOutlineRegular` `IconLinkOutlineRegular` `IconNewChatOutlineRegular` `IconPanelLeftOutlineRegular` `IconPaperclipOutlineRegular` `IconPaperPlaneOutlineRegular` `IconProjectAddOutlineRegular` `IconMicrophoneOutlineMedium` `IconCompactOutlineRegular` `IconEnhanceOutlineRegular` `IconFlatListOutlineRegular` `IconInspectOutlineRegular` `IconCompareSplitOutlineRegular` `IconTreeCornerRegular` `IconWrapLinesOutlineRegular` `IconWrapFillRegular` `IconFileType` 等。

### 7.2 顺带的通用 UI 原语（同包，101 个非图标导出）

`Button` `Checkbox` `Input` `Switch` `Modal` `Menu` `MenuGroup` `MenuItemButton` `MenuSurface` `Tooltip` `Toast` `Tag` `Pill` `StateDot` `SegmentedControl` **`SegmentedTabs`** `SettingsForm` `SettingsFormModel` `SettingsValueField` `SettingsSecretField` `settingsTextField` `settingsNumberField` `RiskConfirmation` `DisclosureRow` `HoverCard` `HoverCardGroup` `JsonTree` `JsonBlock` `MarkdownText` `CodeBlock` `DiffBlock` `ReadBlock` `SearchBlock` `WebBlock` `TerminalBlock` `InlineEditor` `ReferenceChip` `ShortcutKeys` `TextShimmer` `ConnectionIndicator` `BrandWordmark` `FishLogo` `PluginArtwork*` `useModalLayer` `useAnchoredPosition` `useDismissOnOutsidePointer` `relativeTime` `fileSizeText` `closeTopModal` 等。

> 做页签可以直接用 `SegmentedTabs`；做表单可以直接用 `SettingsForm` / `SettingsValueField`，省掉自造。

### 7.3 注意

- **不是 lucide-react**，命名是自有的 `IconXxxOutlineMedium|Regular` 体系。`lucide` 在两个 bundle 与整个 asar 里命中 0 次。
- 如果需要 lucide 风格图标，只能自己内联 SVG 或把图标作为自建包的 client half 提供。

---

## 附：调研用到的解包方法

asar header：`headerSize = buf.readUInt32LE(12)`，header JSON 在偏移 16，文件内容基址 = `16 + headerSize`。
临时脚本目录：`dsh-usage-stats/.tmp/`（已 gitignore），产物：`unpack-asar.cjs` `unpack-filtered.cjs` `ls-header.cjs` `css-vars.cjs` `js-vars.cjs` `slots-scan.cjs` `inject-scan.cjs` `requires-scan.cjs` `export-list.cjs`。
