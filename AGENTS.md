# dsh-usage-stats 项目约定

> 全局规则见 `~/.agents/AGENTS.md`，冲突时以全局规则为准。本文件只写本项目特有的命令、结构与流程，不重复全局内容。

## 项目是什么

DeepSeek Harness 插件：侧边栏「使用统计」独立模块（与「插件」「自动化任务」同级），用六格摘要条、Token 活动热力图、按模型趋势折线、模型用量环形图呈现本机 Token 用量。数据全部来自本机会话日志，零上传、零运行时依赖。

## 插件标识

| 项 | 值 |
|---|---|
| npm 包名 | `@bluechonk/dsh-usage-stats` |
| loader 行 id | `dsh-usage-stats` |
| client 模块 id | `@bluechonk/dsh-usage-stats`（必须与包名逐字一致） |
| 面板 id | `usage-stats`（侧边栏导航行与 `main` keyed slot 共用） |
| 导航顺序 | `order: 20`（「插件」0 与「自动化任务」10 之后、「更多」之前） |
| 导航标题 | 使用统计 |
| 图标 | `icon.svg`（包根 `package.json` 的 `icon` 字段；缺字段时插件面板只画默认占位图） |

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run check` | 语法检查（`lib/` 五个文件） |
| `npm test` | 单元与契约测试（`node --test`，覆盖 `__pure` 直测面与组件渲染） |
| `npm run verify:e2e` | 真实会话回填 → 四条 API 响应形状 |
| `npm run verify:ui` | 真机 UI 冒烟（需要 dsh web 地址） |
| `node docs/verify-dsh-web.mjs boot\|open\|snapshot\|click\|find\|screenshot\|stop` | dsh web + agent-browser 真机验证 |

## 目录结构

```
lib/      fold.js（折叠状态机）store.js（落盘/锁）aggregate.js（日聚合）client.js（UI）index.js（host 接线）
test/     纯函数直测 + 组件渲染冒烟 + 端到端
docs/     设计与验证、审计记录、e2e-verify.mjs、smoke-ui.mjs、verify-dsh-web.mjs、images/
icon.svg、cordis.patch.yml、package.json
```

## 版本与发版

- 版本策略：`0.1.x` 自用迭代，不做兼容性承诺；`0.2.0` 留给不兼容的界面改版。
- 不发布到 npm，只经 GitHub 链接安装。
- **版本号只在发版时 bump**，`0.1.x` 连续递增不跳号（改代码不动版本号）。
- **发版 = 打 tag，不建 GitHub Release**；tag 打在合并后的 `main` 上，与 CHANGELOG 段落一一对应。
- 发版流程：改代码 → `npm run check` + `npm test` 全绿 → bump 版本号并写 CHANGELOG → 分支 + PR → 合并 → 打 tag（`git tag -a vX.Y.Z`）。

## 真机验证（唯一路径：dsh web + agent-browser）

desktop 是 Electron 且没有调试端口，agent-browser 连不上；**dsh web 与 desktop 加载同一套 Web UI、读同一份数据**，验证结论一致。测试实例的插件组合与 desktop 相同（临时 profile 复制 desktop 清单 + `node_modules` 目录联接）。

```bash
node docs/verify-dsh-web.mjs boot                          # 起测试实例（约 10s），打印掩码地址
node docs/verify-dsh-web.mjs open                          # agent-browser 打开
node docs/verify-dsh-web.mjs snapshot                      # 无障碍树，拿 @ref
node docs/verify-dsh-web.mjs click '@e11'                  # 点击（ref 来自 snapshot）
node docs/verify-dsh-web.mjs find role button click --name 使用统计   # 语义定位，不依赖 ref
node docs/verify-dsh-web.mjs screenshot /abs/path/x.png    # 截图（绝对路径）
node docs/verify-dsh-web.mjs stop                          # 停实例 + 删临时 profile
```

注意：

- PowerShell 里 `@ref` 必须加引号（`'@e11'`），否则被当成 splatting 参数吞掉。
- agent-browser 的 CLI 执行完可能留守护进程占住管道，脚本已用输出重定向 + 超时兜底。
- 实例地址带 token：只在 `.tmp/dsh-web-verify.url`，不入库、不打印（`url` 命令默认掩码）。
- 不要动 `~/.dsh/profiles/desktop` 的运行实例；验证一律走临时 profile。

## 代码与提交约定

- 注释与文档用中文、无 emoji、LF（`.gitattributes` 已配 `* text=auto eol=lf`）。
- 临时脚本与中间产物放 `.tmp/`（已忽略）；可复用流程沉淀到 `docs/`。

### 提交信息

- 格式 `type(scope): 中文描述`；`type` 只用 `feat` / `fix` / `perf` / `refactor` / `docs` / `chore` / `test` / `merge`。
- `scope` 用模块名：`ui`（`lib/client.js`）、`store`、`fold`、`aggregate`、`host`（`lib/index.js`）、
  `repo`（包声明、文档、脚本、配置等仓库级改动）；跨模块用逗号分隔，如 `fix(store,aggregate): …`。
- **正文必写**：为什么这么改 + 做了什么（中文，必要时用 bullets 列点）；只有一行 subject 说不清的改动
  必须补 body。不允许空 body 的「大字报」提交。

### 分支与 PR

- 分支名 `type/kebab-desc`（如 `fix/ui-narrow-context`、`feat/context-message-split`）。
- **PR 标题 = 该 PR 要落地的提交标题**；一个 PR 一个语义变更。
- **PR 用 Squash 合并，禁止 merge commit 与 rebase merge**（保持 `main` 线性历史；遵循全局规则）。
  squash 后 `main` 上那条提交的标题与正文就是 PR 标题与正文——先按提交信息规范写好 PR。
- 小改动先在本地 `commit` 攒着，攒够一批再走 PR。

### 提交工作流（小步提交 + 合并前整理）

1. **分支上小步提交**：开发时随手 `git commit`，允许 `wip: 尝试 xxx`、`tmp:` 这类中间提交，不追求一步到位。
2. **合并前整理**：功能稳定后 `git rebase -i <base>`——压缩 wip、重排顺序、合并同主题提交，整理成语义清晰的提交。
3. **推送前复查**：`git log --oneline <base>..HEAD` 逐个过一遍，确认每个提交都符合上面的提交信息规范，且 `npm run check` 通过（能跑 `npm test` 就跑）。
4. **再推远程、开 PR**，PR 用 Squash 合并（PR 标题走 Conventional Commits）。

注意：不要改写**已经推送**的历史（那需要 force-push，也会让 tag 与提交脱节）；需要调整就新开分支。

## 禁止

- 不提交 token / 凭据（包括 dsh web 地址里的 token）。
- 不建 GitHub Release（本仓库惯例：只打 tag）。
- 不发布到 npm。
- 不为了验证去重启或改配置正在运行的 desktop 实例。
