# dsh-usage-stats

[![CI](https://github.com/bluechonk/dsh-usage-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/bluechonk/dsh-usage-stats/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/bluechonk/dsh-usage-stats?label=version)](https://github.com/bluechonk/dsh-usage-stats/tags)
[![license](https://img.shields.io/github/license/bluechonk/dsh-usage-stats?label=license)](https://github.com/bluechonk/dsh-usage-stats/blob/main/LICENSE)

> DeepSeek Harness 社区插件「使用统计」：在设置页新增「使用统计」分区，用六格摘要条、GitHub 式 Token 活动热力图、按模型趋势折线、模型用量环形图呈现本机 Token 用量。数据全部来自本机会话日志，零上传、零运行时依赖。

- **插件 id**：`dsh-usage-stats`（宿主内稳定标识）
- **npm 包名**：`@bluechonk/dsh-usage-stats`
- **适配宿主**：DSH 0.2.1-rc.2（web / desktop profile 均可安装；面板 UI 在 web / desktop 呈现）
- **运行环境**：宿主 Node ≥ 22.15（历史回填用到 `node:zlib` 的多帧 zstd 解压）
- **数据位置**：全部在本地 `~/.dsh/usage-stats/`，不上传任何远端
- **网络**：仅本机 loopback（API 走内核 webServer 同源反代），无遥测零上传
- **运行时依赖**：零（无需 `npm install`）
- **许可**：MIT License（见 [LICENSE](LICENSE)）

## 目录

- [功能介绍](#功能介绍)
  - [六格摘要条](#六格摘要条)
  - [Token 活动热力图](#token-活动热力图)
  - [时间范围与趋势折线](#时间范围与趋势折线)
  - [模型用量环形图](#模型用量环形图)
  - [数据口径](#数据口径)
  - [键盘可达](#键盘可达)
  - [健壮性与降级](#健壮性与降级)
- [安装](#安装)
- [验证生效](#验证生效)
- [配置](#配置)
- [数据与隐私](#数据与隐私)
- [回滚与卸载](#回滚与卸载)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [致谢](#致谢)

## 功能介绍

面板挂在设置页「使用统计」分区（`settings.section` order 13），标题「使用统计」，标题右侧带「应用用量」徽章，副题「查看会话活跃度与模型用量的粗略统计。」

### 六格摘要条

一排六格：**累计 Token 数 / 峰值 Token 数 / 缓存命中率 / 最长聊天时长 / 当前连续天数 / 最长连续天数**。

- 大数字用短格式：≥1 万显示「x.x 万」，≥1 亿显示「x.x 亿」。
- 窗口宽度不足时**整格折行**，标签不截断（分隔线用列间隙 + 外扩阴影画，折行后行首不留孤线）。
- 每格悬停给出精确值与口径说明。

| 指标 | 口径 |
| --- | --- |
| 累计 Token 数 | 输入 + 输出 + 缓存命中 + 缓存写入 + 推理，全期求和 |
| 峰值 Token 数 | 单日四桶之和最大的一天 |
| 缓存命中率 | 缓存命中 Token ÷（缓存命中 + 未缓存输入）；无输入时显示「—」 |
| 最长聊天时长 | 按（会话, 日）分桶取最长一次，跨日会话按日截断 |
| 当前 / 最长连续天数 | 每天 Token>0 算活跃；今天有用量从今天往回数，今天没有则从昨天往回数 |

### Token 活动热力图

GitHub 式格子，最近 **52 个自然周**（周日起始，末列对齐当前周），下方一行月份标签。右上角胶囊三档切换：

- **每日**：一格一天，五档色阶；悬停显示「2026年10月3日 / 1.2万 tokens · 5 轮消息」。
- **每周 / 累计**：整列变为底部对齐的色块柱；悬停显示该周末位日期，外加同口径的两个数（周合计 / 截至此周累计）。

热力图配色跟随宿主亮暗主题自动切换。键盘可达：容器是一个 tab stop，聚焦后 ← → 走周、↑ ↓ 走日、Home / End 到两端。

### 时间范围与趋势折线

「时间范围」标题行右侧胶囊切换 **近 7 日 / 近 30 日**，**只作用于下方趋势折线**。

「每日 Token 趋势图」按模型分多条彩色折线：

- 折线用单调三次插值（Fritsch–Carlson）绘制，平滑且绝不过冲。
- Y 轴域取「单模型单日峰值」而非当日总量——独立折线不是堆叠图，否则多模型场景会被压扁到底部。
- 顶部图例**纯展示**：全部模型恒定列出，不可点击隐藏。
- 悬停显示当天各模型的 token 用量。

### 模型用量环形图

左侧环形图（中心显示总 token 数），右侧列表逐模型给出**模型名 + 占比 + token 数**。模型超过 6 个时，前 6 名单列，剩余合并为「其他模型」（悬停可看并了谁）。环图扇区与列表行均有悬停提示。

本卡统计**全部用量**（标题右侧带「全部」标记，tooltip 注明「全部用量」），**不受上方「时间范围」影响**。

### 数据口径

页面各块口径不同，请勿互相套用：

| 数据 | 口径 | 受「近 7 日 / 近 30 日」影响 |
| --- | --- | --- |
| 摘要条六格 | 全期 | 否 |
| Token 活动热力图 | 最近 52 自然周 | 否 |
| 每日 Token 趋势图 | 近 7 日 / 近 30 日 | 是 |
| 模型用量环图 | 全期 | 否 |

### 键盘可达

热力图与趋势图各只占一个 tab stop，聚焦后用方向键移动游标（热力图 ← → 走周、↑ ↓ 走日；Home / End 到两端），复用同一张悬停卡片。Tab 键正常放行，不被拦截。图表容器带 `role="img"` 与 `aria-label`，胶囊按钮带 `aria-pressed`。

### 健壮性与降级

- 三态渲染：加载中 / 空态 / 失败态（带行内重试）。
- 单路接口失败只降级对应卡片，不炸整面板；**已有旧数据时也会显式标注「未更新，显示为上次数据」并给行内重试**。
- 每轮刷新记录「更新于 HH:MM」；有路失败时冻结时间戳并标注「（部分数据未更新）」。
- 面板组件包在错误边界里，渲染异常时降级为兜底横幅，不拖塌整个设置页。
- 静默轮询 60 秒一拍，不闪「加载中」；后台标签页跳拍、切回前台补一拍、关页面即停。
- 写盘侧有单写者锁与归属校验：锁被抢占后原写者立即停写并降级为只读镜像，绝不出现双实例互抹账本。

## 安装

### 方式一：本地目录注册（开发用，推荐）

1. 把本目录放到任意位置，在 `$DSH_HOME/profiles/<profile>/node_modules/@bluechonk/` 下创建指向本目录的链接（Windows 用 junction）：

   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@bluechonk"
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@bluechonk\dsh-usage-stats" -Target "<本目录绝对路径>"
   ```

2. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh-usage-stats
         name: "@bluechonk/dsh-usage-stats"
         config: {}
   ```

3. 重启该 profile 的 DSH 实例，刷新页面。

> 插件的 client 半在页面加载时注入，修改 `lib/client.js` 后刷新页面即可生效；
> host 半（`lib/index.js`）改动需重启 DSH。

### 方式二：Git 克隆安装

```bash
git clone https://github.com/bluechonk/dsh-usage-stats.git
# 然后按「方式一」的第 1、2 步注册
```

## 验证生效

打开设置页 → 左侧「使用统计」，应看到六格摘要条、热力图、趋势折线与模型用量环形图。

首次装上后，历史会话的用量由插件在**后台自动回填**（扫描 `~/.dsh/sessions` 下的历史会话文件），补完即自动显示，期间面板会显示回填进度。若长时间未出现数据，检查 `~/.dsh/usage-stats/` 目录是否可写。

## 配置

在 `cordis.patch.yml` 的 `config` 段可配三个键（未知键会直接报错，不静默忽略）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 置 `false` 关闭插件（不采集、不落盘） |
| `storageRoot` | `~/.dsh/usage-stats` | 统计数据目录（JSONL 流水 + daily 缓存 + 锁 + 回填游标） |
| `sessionsRoot` | `~/.dsh/sessions` | 会话日志目录（历史回填的扫描源） |

```yaml
- insert:
    - id: dsh-usage-stats
      name: "@bluechonk/dsh-usage-stats"
      config:
        storageRoot: "D:/dsh-stats"
```

## 数据与隐私

- 所有统计在**本机**完成：事件由宿主 `session/event` 推送，折叠后落盘到 `~/.dsh/usage-stats/`，接口走本机 loopback 同源反代。
- 插件**不上传任何数据**，无遥测、无第三方请求。
- 只读自己的会话日志，不修改会话文件。
- 接口有 loopback 守卫：仅接受本机请求，且 Host 头与 Origin 必须同源。

## 回滚与卸载

1. 从 profile 的 `cordis.patch.yml` 移除上面的 `insert` 段，重启该 profile 的 DSH 实例。
2. 删除 `~/.dsh/usage-stats/` 目录即可清空统计数据（不影响会话日志）。
3. 删除 `node_modules/@bluechonk/dsh-usage-stats` 链接。

## 开发与测试

零运行时依赖，测试用 Node 内置 `node:test`：

```bash
npm run check        # 语法检查
npm test             # 单元测试（146 个用例）
npm run verify:e2e   # 端到端：用本机会话日志跑一遍回填，校验四条 API 的响应形状
npm run verify:ui    # 真机 UI 冒烟：驱动真实浏览器打开设置页，断言面板完整渲染且无控制台错误
```

`verify:e2e` 只读 `~/.dsh/sessions`，统计落盘到临时目录并在结束时自动清理，不污染 `~/.dsh/usage-stats/`。

`verify:ui` 需要一个正在运行的 DSH 实例 URL（形如 `http://127.0.0.1:3080/?token=...`，启动日志里会打印）与一个 Chrome 路径：

```bash
node docs/smoke-ui.mjs "http://127.0.0.1:3080/?token=xxx" "C:/path/to/chrome.exe" .tmp
```

相关文档：

- [SPEC.md](SPEC.md)——技术规格：事件形状、折叠语义、锁与落盘纪律、接口契约、UI 细则
- [docs/audit-report.md](docs/audit-report.md)——三轮代码审核的结论与修复记录
- [docs/dsh-client-runtime-capabilities.md](docs/dsh-client-runtime-capabilities.md)——DSH 客户端插件运行时能力调研（slots API、CSS 变量、模块表）
- [docs/e2e-verify.mjs](docs/e2e-verify.mjs)——端到端验证脚本
- [docs/smoke-ui.mjs](docs/smoke-ui.mjs)——真机 UI 冒烟脚本

## 已知限制

- 热力图固定回看 52 自然周，更早的用量只计入摘要条等全期口径。
- 最长聊天时长按（会话, 日）分桶取极差，跨日会话按日截断，是近似口径。
- 趋势折线悬停卡片最多列 8 个模型行，超出注「另有 N 个模型未列出」。
- 缓存命中率只统计缓存命中与未缓存输入，不含输出与推理。
- 插件在会话中途启用时，该会话启用前的用量不会被回填（宁漏勿双计）。
- 落盘失败造成的 seq 空洞会被推导水位跨过，该笔净增量不再补齐（仅在连续多事件写盘失败时触发）。
- 完整清单见 [SPEC.md §9](SPEC.md)。

## 致谢

- 界面形态参考 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）的「应用用量」面板设计。
- 采集与折叠语义对齐官方 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影。
- 看板实现基于 [axuan-1314/dsh-usage-stats](https://github.com/axuan-1314/dsh-usage-stats)（MIT）。
- 早期版本源自 [Make0209/dsh-usage-stats](https://github.com/Make0209/dsh-usage-stats)（MIT），本仓库在此基础上重做了看板。
