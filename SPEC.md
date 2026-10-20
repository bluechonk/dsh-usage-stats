# dsh-usage-stats 技术规格

DSH 官方桌面版「使用统计」插件。插件订阅宿主 `session/event` 事件流，按官方 tokenUsage 投影语义折叠出净增量、落盘为本地 JSONL，并向设置页面板提供若干只读 API。数据全部留在本机，零上传、零运行时依赖。

事件与文件形状以 DSH 0.2.0-rc.2 源码实证为准；运行环境为 Node 24.x（历史回填使用 `node:zlib` 的多帧 zstd 解压）。工程约定：ESM（`"type":"module"`）、零 npm 依赖、全中文注释且只记录代码看不出的约束；存储与聚合出错必须显式（记日志 + 可见降级），禁止 fail-open 静默吞错。

## 0. 模块划分

| 模块 | 职责 |
|---|---|
| `lib/fold.js` | 折叠状态机，产出笔级净增量 |
| `lib/store.js` | JSONL 落盘、月轮转、日聚合缓存读写、单写者锁 |
| `lib/aggregate.js` | 日聚合 → API 响应形状（纯函数，零 IO 零时钟） |
| `lib/client.js` | 设置页面板全部（React 组件 + 样式 + 三态） |
| `lib/index.js` | host 接线：事件采集 → fold → store；路由注册；历史回填 |

## 1. 会话事件形状

监听入口为 `ctx.on("session/event", (session, event) => …)`；`session.id` 是会话 uuid，`event.seq` 是事件序号。

| 事件 | data 形状 | 用途 |
|---|---|---|
| `assistant/message` | `{message:{source:{provider,model,replayState?}}, turn, step, usage?, stream?}` | 主采样点；顶层 `usage` 优先，缺省时回落 `stream` 末块 usage（message 事件同样携带 stream） |
| `assistant/attempt` | `{turn, step, stream:[{type:"chunk", chunk:{type,…}}…]}` | 失败尝试采样：从后往前第一条 `record.type==="chunk" && record.chunk.type==="usage"` 的 `record.chunk.usage` |
| `llm/retry-started` | `{turn, step, …}` | 清替换槽（见 §2） |
| `turn/end` | `{reason:{kind,…}}` | 冲刷信号；fold 逐事件即时产出增量，可忽略 |

`usage` 原始形状（pi-ai `mapUsage`）：`{inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?}`——cache 两项为 0 时字段缺省。pi-ai 路线 reasoning 已折入 `outputTokens`，不单列。`replayState` 是 pi-ai 消息的常规字段，不是 fork 标记。

## 2. fold 折叠语义

状态形状：`{ totals:{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, last:{turn,step,buckets} | null }`，按 sessionId 各一份。语义照抄 `@deepseek-ai/dsh-token-meter` 的 tokenUsage 投影，不建议改动。

```
apply(state, event):
  if type === "llm/retry-started":
    if last 存在且 last.(turn,step) === data.(turn,step): last = null   # 清槽，此后同键样本走累加
    return (是否改动)
  if type ∉ {"assistant/message","assistant/attempt"}: return 无变化
  sample = message ? (data.usage 存在则取之，否则 stream 末块) : (stream 末块 usage，无则无变化)
  buckets = { uncachedInputTokens: usage.inputTokens,          # 直接取 inputTokens，不减缓存
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cacheWriteTokens ?? 0 }
  previous = (last 同键) ? last.buckets : null
  if previous 与 buckets 全等: return 无变化                       # 同键同值 no-op
  delta = buckets - (previous ?? 0)                                # 四项逐项相减；replace 时可为负
  totals += delta; last = {turn, step, buckets}
  return {增量 delta, kind: previous ? "replace" : "add"}
```

要点：官方 totals 语义 = 「替换槽 LWW + retry-started 结转清槽后同键累加」。增量流对每条 record 求和恒等于官方 totals，这是聚合对账的成立基础。`totalTokens` 不落盘（四桶可推导）。非有限数样本（NaN / 缺字段）按无变化丢弃——此为安全方向的偏离，宁丢一条也不让 NaN 毒化后续聚合。

fork 去重：内核 `buildForkSeed` 在继承前缀末尾插入 `{type:"session/end-seed", data:{inherited:true}}`，剪切点 = 最后一个该标记的 seq，回填只统计其后事件。标记缺 seq（畸形）视为无标记、不剪，宁多计已知事件也不静默丢会话。

## 3. 落盘格式与目录

目录默认 `~/.dsh/usage-stats/`，可由配置 `storageRoot` 覆盖（测试注入临时目录）：

```
records-YYYY-MM.jsonl   笔级增量流水，按 record.time 本地月份归文件，一行一条 JSON，追加写
daily/YYYY-MM-DD.json   日聚合缓存（§4 形状），原子写（tmp + rename）
lock                    单写者锁（O_EXCL 创建 + pid/实例戳；mtime 距今 ≥5min 判定持有者已死可接管）
backfill-marker.json    回填游标 v4：{done:[sid,…], watermarks:{sid:seq}, mtimes:{sid:mtimeMs}, updatedAt}
```

record 一行形状（字段全名，不压缩，含会话内事件序号 `seq`）：

```json
{"time":1696300000000,"seq":17,"sessionId":"uuid","provider":"deepseek","model":"deepseek-chat","turn":3,"step":1,"kind":"add","usage":{"uncachedInputTokens":123,"outputTokens":456,"cacheReadTokens":0,"cacheWriteTokens":0}}
```

`kind`：`"add"` 新样本 / `"replace"` 同键替换差值（usage 四项可为负，聚合求和自然抵消）。纪律：写失败不炸宿主轮次（首条记 warn，其后每连续 10 条升 error），读失败按空文件处理但记 warn；月轮转按月分文件自然实现，无后台任务。单写者锁被抢占后，原写者续写前校验归属并抛 `LOCK_LOST`，避免幽灵写者互抹账本。

## 4. 日聚合

```json
{"version":1,"date":"2026-10-03",
 "byModel":{"deepseek/deepseek-chat":{"uncachedInputTokens":n,"outputTokens":n,"cacheReadTokens":n,"cacheWriteTokens":n,"samples":n,"turns":n}},
 "byHour":[24 个数——每小时四桶之和],
 "sessions":{"<sid>":{"firstMs":n,"lastMs":n}}}
```

模型 key = `"<provider>/<model>"`。`turns` 计数：`kind==="add"` 且该 `(sessionId, turn)` 当日首见才 +1（按 seen 集全局去重，与模型无关）。全项目统一口径 `totalTokens` = 四桶之和（`uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`），与官方 trajectory「用量」四项可逐项对账。日聚合可随时由 records JSONL 全量重建（`rebuildDaily(records)` 纯函数）。

## 5. HTTP API

路由挂在宿主内核 webServer 下，loopback 守卫（仅放行本机请求，读路由放行 GET/HEAD）：

| 路由 | 入参 | 响应 |
|---|---|---|
| `GET /api/dsh-usage-stats/summary` | — | `{since, totalTokens, peakDay:{date,tokens}|null, longestChatMs, currentStreakDays, longestStreakDays, cacheReadTokens, uncachedInputTokens, cacheHitRate}` |
| `GET /api/dsh-usage-stats/heatmap` | `?days=N`（默认 366，0=全量） | `{days:[{date:"YYYY-MM-DD", tokens, turns}]}` 逐日全量；weekly/total 列聚合由 client 计算 |
| `GET /api/dsh-usage-stats/trend` | `?days=1\|7\|30` | days=1 → `{granularity:"hour", points:[{label:"0时"…"23时", byModel:{key:tokens}, total}]}`；否则 `{granularity:"day", points:[{date, byModel, total}]}` |
| `GET /api/dsh-usage-stats/models` | `?days=7\|30` | `{models:[{key, provider, model, tokens, share}], total}`，按 tokens 降序 |
| `GET /api/dsh-usage-stats/backfill/status` | — | `{running, startedAt, scanned, total, backfilled, records, lostFrames, finishedAt, error}` |
| `POST /api/dsh-usage-stats/backfill` | — | 202 受理制：`{ok, started:true}` 即返，任务后台分片执行；并发触发返回 409 |

摘要条口径：`totalTokens` 全期求和；`peakDay` 为单日四桶之和最大的一天；`longestChatMs` 按 `(sessionId, date)` 分桶取 `lastMs-firstMs` 的全期最大值（跨日会话按日截断，近似）；`currentStreakDays` 为「今天有用量=1，往回连续有用量天数」（今天没有则从昨天往回数），`longestStreakDays` 为历史最长；`cacheHitRate` 为缓存命中 Token ÷（缓存命中 + 未缓存输入）×100，无输入时为 `null`（前端显示「—」）。空数据返回 `totalTokens:0, peakDay:null, longestChatMs:0, streak:0, cacheHitRate:null, since:当天`。

## 6. 面板 UI 与交互

UI 描述以本节为准。面板挂在设置页 `settings.section`，`order: 13`（12 已由同生态插件占用），label「使用统计」。React 接入与依赖注入沿用同生态插件的既有做法，不引入额外 hook/状态库。

硬性要求：

1. 样式全部 `dus-*` 前缀命名空间，零官方类名依赖；双主题跟随官方 theme。
2. 六块 UI：**六格摘要条**（`repeat(auto-fit,minmax(132px,1fr))` 自适应折行，标签不截断；分隔线用「1px 列间隙 + 格子外扩阴影」画，折行后行首无孤线）/ **热力图**（52 自然周列、周日起、`repeat(52,minmax(0,1fr))` 等分无滚动、`ceil(v/max*4)` 五档、每日/每周/累计三档切换、每周/累计为列底对齐色块柱、无图例）/ **时间范围胶囊**（近 7 日/近 30 日，默认近 30 日；标题行文案「时间范围」）/ **趋势折线**（单调三次插值 Fritsch–Carlson：切线 = 3× 相邻段斜率限幅，遇重复横坐标 `dx<=0` 置 `s=0` 防 NaN；Y 域 `[0, 单模型单日峰值]`；Y 轴隐藏；X 刻度 ≤14 全标否则首尾每 5；tooltip 卡片「{月日} - {总量} tokens」+ 分模型行，8px 圆点 + 名称 + mono 数值 +「tokens」单位，0 用量行过滤）/ **模型环形图**（半径 rO=76 / rI=50.4、paddingAngle 2、中心总量、右侧图例色块 + 等宽名 + 百分比 + token 数、超 6 个归并「其他模型」）/ 右下刷新按钮。标题右侧带「应用用量」徽章。
3. 三态：加载（骨架或文案）/ 空态 / 错误态（重试按钮）。单路 fetch 失败只降级对应卡片并给行内「重试」，不炸整面板；卡片级降级行只在该路本次失败时出现，「尚未到达」显示「加载中…」。
4. 数字格式化：`≥1 万` 显示「x.x 万」、`≥1 亿` 显示「x.x 亿」（摘要条，万档四舍五入后 ≥10000 改走亿档）；图表 tooltip 用同一套万/亿简写（热力图悬停的 token 数同样简写，不用完整千分位）。
5. 静默轮询：60 秒一拍，恒拉 summary 与当前 range 的 trend（非今日档再加 models），不闪「加载中」，后台标签页跳拍、切回前台补一拍、关页面即停。热力图按需刷新：当且仅当本拍 summary 的 `totalTokens` 或「今天」与上一拍不同时追加一次 heatmap；拉失败不推进判定基线（否则判定信号被消费、热力图静默冻结）。
6. 「更新于 HH:MM」仅在同一拍内实际发起的每一路都成功时推进；有路失败则冻结时间戳并追加「（部分数据未更新）」。
7. phase 转移：初始加载与显式刷新（`full`）全权转移；静默拍单调——`prev==="ready"` 恒保持 ready，`next==="ready"` 且 prev 非 ready 时升为 ready，其余 no-op。静默拍永不进 `loading`、不打回 `empty`/`error`；被新拍顶掉的初始拍至少要把面板从 `loading` 放出。
8. 键盘可达：热力图与趋势图各只占一个 tab stop（容器 `tabIndex=0`），聚焦后用方向键移动游标并复用同一数据卡片；只接管 ← → ↑ ↓ Home End 六键，其余（含 Tab）不拦截；首次按键游标落在今天（热力图 `51*7 + 星期几`）/ 最新一点；游标只存索引（像素锚点渲染时现算），热力图游标格加 `.dus-hmCur` 描边（缺勤日也可见）；胶囊补 `aria-pressed`，可点元素补 `:focus-visible`，图表容器补 `role="img"` + `aria-label`（热力图「共 N 天有用量」从原始逐日数组算，避免读到柱格数）。
9. 趋势图例**纯展示**：全部模型恒定列出，不可点击隐藏/恢复（`<span>` 渲染，不可聚焦）。趋势卡片行数封顶 8 行 + 「另有 N 个模型未列出」。
10. 悬停卡片使用自定义浮层（非原生 `title`）：分侧定位并钳位到容器内，环形图定位容器为整行 `.dus-donutRow`；`.dus-tip` 用 `box-sizing:border-box` + `max-width:calc(100% - 16px)` 保证钳位数学不失真。所有 token 数值（热力图 tooltip、趋势 tooltip 标题与明细行、环形图中心与列表、环形 tooltip）一律走万/亿简写 `fmtCompact(v, true)`，不用完整千分位；精确值只出现在元素的 `title` 悬停说明里。
11. 回填进度全程可见：挂载即读一次 `GET /backfill/status`，`running=true` 进入跟踪态；跟踪走单一 ticker，800ms 一拍，布尔判据防重入。`running` 由 true 转 false 且确实观察到过 true 才做一次全量刷新；`status.error` 非空即显式失败文案。回填由宿主在装载时自动触发（面板不提供手动按钮）。
12. 界面文案逐字定稿（测试断言以此为准）：空态 `暂无使用数据`、`开始对话后这里会显示 Token 活动与模型用量；若刚装上插件，历史会话会在后台自动补进来。`；跟踪中 `正在回填历史会话…`、`已扫 {X}/{Y} 会话，完成后这里会自动显示统计。`；完成 `回填完成：补了 {N} 个会话、{R} 条记录。`；失败 `回填失败：{原因}`；全失败态 `加载失败` / `统计服务暂时不可用，请稍后重试。`；摘要条标签 `累计 Token 数` / `峰值 Token 数` / `缓存命中率` / `最长聊天时长` / `当前连续天数` / `最长连续天数`；缓存命中率无输入时显示 `—`。
13. 纯函数直测面：`__pure` 导出折叠与 UI 的算术、布局与转移逻辑，供单元测试直接调用。

## 7. 索引与回填

- 采集：`session/event` → `fold.apply` → 有增量则 `store.append(record)`（含 `seq`），同步维护日索引与当日 daily 缓存（防抖 2s 合并写）。
- 记账水位从 records 推导（按 sessionId 聚合 `max(seq)`，records 为唯一真源，SIGKILL 无丢失窗）；live 侧不写 marker。marker 中的 `watermarks` 语义收窄为「bootstrap 基线」，仅 mtime 哨兵与空会话分支写入起点 seq；读旧版文件时其 watermarks 整包并入基线（取大，向后兼容）。
- 回填：`node:zlib` 逐帧解压多帧 zstd 会话文件，递归扫 `~/.dsh/sessions/<workspace编码目录>/<sessionId>/session.v*.jsonl.zstd`；筛四类事件喂同一 fold 状态机（全文件重放以保槽基线），只落 `seq > 水位` 的增量 record。async 分片（每 4 会话让出一拍），动态 foldStates 守卫挡 live 交错。
- 触发：装载即自动回填一轮（幂等增量，按 marker.done/水位跳过）；进度经 `GET /backfill/status` 轮询，失败信号经 `error` 字段直达面板。`POST /backfill` 保留为宿主侧接口（供外部触发），面板不提供手动按钮。

## 8. 测试要求

- `node --test`，文件名 `*.test.mjs` 放 `test/`；所有 options 对象必须位于第二参位（第三参会被 node:test 静默忽略）。
- 每个异步测试显式 `{timeout: 5000}`；临时目录用 `mkdtemp` 创建并在 `finally` 清理。
- 断言用 `node:assert/strict`。
- fold 用例五类：①同键替换（后值换前值，totals 正确增减）②retry-started 清槽后同键累加 ③带 usage 的 `interrupted` message 照常计 ④无 usage 事件跳过 ⑤attempt stream 末块采样。
- store 用例：追加 / 月分文件 / 锁互斥 / 陈旧接管 / 损坏行跳过；aggregate 用例：四路由形状 / streak 峰值 / turns 去重 / 空数据形状。
- 纯函数单元测试只覆盖算术与转移表，不覆盖生命周期（轮询重入、卸载清理、真实 60s 拍、tooltip 真实定位），后者只能经真实交互验证。

## 9. 已知局限性

- live 折叠槽在内存，进程重启即弃：替换窗横跨重启时旧样本被双计，极罕见。
- 回填路径 attempt 样本的模型归属依赖会话内 `request/header` 前置，缺失时记 unknown。
- 最长聊天时长按（会话, 日）分桶取极差，跨日会话按日截断，是近似口径。
- 少数「有水位无 mtime」的历史会话每次装载仍会解压（约 0.7~4 秒）。
- 多帧 zstd 帧边界靠魔数扫描，理论上有极低概率误报；解压失败帧跳过并计数留痕。
- 热力图固定回看 52 自然周，更早用量只计入摘要条等全期口径；「每周/累计」档悬停卡片取该周末位日期与周合计。
- 趋势悬停卡片最多列 8 个模型行，超出注「另有 N 个模型未列出」。
