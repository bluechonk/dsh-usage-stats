# dsh-usage-stats 技术规格

DeepSeek Harness 社区插件「使用统计」：订阅宿主 `session/event` 事件流，按官方 tokenUsage 投影语义折叠出净增量、落盘为本地 JSONL，并向设置页面板提供只读 API。数据全部留在本机，零上传、零运行时依赖。

事件与文件形状以 DSH 0.2.1-rc.2 源码实证为准；运行环境 Node ≥ 22.15（历史回填使用 `node:zlib` 的多帧 zstd 解压）。工程约定：ESM（`"type":"module"`）、零 npm 依赖、全中文注释且只记录代码看不出的约束；存储与聚合出错必须显式（记日志 + 可见降级），禁止 fail-open 静默吞错。

## 0. 模块划分

| 模块 | 职责 |
|---|---|
| `lib/fold.js` | 折叠状态机，产出笔级净增量（纯函数） |
| `lib/store.js` | JSONL 落盘、单写者锁、月轮转、日聚合缓存读写 |
| `lib/aggregate.js` | 日聚合 → API 响应形状（纯函数，零 IO 零时钟） |
| `lib/client.js` | 设置页面板全部（React 组件 + 样式 + 三态） |
| `lib/index.js` | host 接线：事件采集 → fold → store；路由注册；历史回填 |

## 1. 会话事件形状

监听入口为 `ctx.on("session/event", (session, event) => …)`；`session.id` 是会话 uuid，`event.seq` 是事件序号。

| 事件 | data 形状 | 用途 |
|---|---|---|
| `assistant/message` | `{message:{source:{provider,model,replayState?}}, turn, step, usage?, stream?}` | 主采样点；顶层 `usage` 优先，**缺省或为 `null`** 时回落 `stream` 末块 usage（message 事件同样携带 stream） |
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
  sample = message ? (data.usage 存在且非 null 则取之，否则 stream 末块) : (stream 末块 usage，无则无变化)
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

**顶层 `usage` 为 `null` 与缺省同义**：都回落 `stream` 末块采样。写成「仅在 `undefined` 时回落」会让 `null` 直接返回「无变化」，把本可采到的用量整条漏计。

fork 去重：内核 `buildForkSeed` 在继承前缀末尾插入 `{type:"session/end-seed", data:{inherited:true}}`，剪切点 = 最后一个该标记的 seq，回填只统计其后事件。标记缺 seq（畸形）视为无标记、不剪，宁多计已知事件也不静默丢会话。

## 3. 落盘格式与目录

目录默认 `~/.dsh/usage-stats/`，可由配置 `storageRoot` 覆盖（测试注入临时目录）：

```
records-YYYY-MM.jsonl   笔级增量流水，按 record.time 本地月份归文件，一行一条 JSON，追加写
daily/YYYY-MM-DD.json   日聚合缓存（§4 形状），原子写（tmp + rename）
lock                    单写者锁：O_EXCL 创建写 pid+时间戳；mtime 距今 ≥5min 判定持有者已死，可接管
lock.claim              接管互斥凭据：陈旧锁接管时用 O_EXCL 独占，避免两实例互删对方新锁（TOCTOU）
backfill-marker.json    回填游标 v4：{done:[sid,…], watermarks:{sid:seq}, mtimes:{sid:mtimeMs}, updatedAt}
```

record 一行形状（字段全名，不压缩，含会话内事件序号 `seq`）：

```json
{"time":1696300000000,"seq":17,"sessionId":"uuid","provider":"deepseek","model":"deepseek-chat","turn":3,"step":1,"kind":"add","usage":{"uncachedInputTokens":123,"outputTokens":456,"cacheReadTokens":0,"cacheWriteTokens":0}}
```

`kind`：`"add"` 新样本 / `"replace"` 同键替换差值（usage 四项可为负，聚合求和自然抵消）。

### 写盘纪律

- 写失败不炸宿主轮次：丢弃该条并内部计数（首条记 warn，其后每连续 10 条升 error，防日志风暴）。上层据此**不推进**折叠水位——落盘失败的事件不能标「已记账」。
- 读失败按空文件处理但记 warn（可见降级，不静默吞）。
- 月轮转按月分文件自然实现，无后台任务。

### 单写者锁的归属校验（硬性）

锁被抢占后，原写者续写前必须校验归属并抛 `LOCK_LOST`，避免幽灵写者互抹账本。**所有写入路径都要过这一关**：

| 路径 | 校验点 |
|---|---|
| `append(record)` | 写前 `assertOwnership()`；失败按「没落盘」处理（返回 false），上层不推进水位 |
| `writeBackfillMarker(obj)` | 写前 `assertOwnership()`；失败抛 `LOCK_LOST` |
| `touchLock()`（60s 心跳） | 校验 + 续期 mtime；归属丢失即降级为只读镜像 |
| `close()` | 只在**确证归属**时删锁；归属不可确认（读不到/解析失败）时**不删**——那把锁可能是别人正在创建的半成品，删掉等于给并发实例开闸 |

内存态 `lockHeld` 可能是「已被别人陈旧接管后残留」：`acquireLock()` 必须**以盘上 pid 为准复核**，不能见到 `lockHeld` 就直接返回（否则调用方会误判自己仍是写者，与真持有者并行写）。

陈旧锁接管用 `lock.claim` 独占凭据串行化：两个实例可能同时判定同一把锁陈旧，各自 `rm` 再 `wx` 会删掉对方刚建的新锁。流程为「抢 claim → 复核 mtime 仍陈旧 → 删旧建新 → 释放 claim」。

**claim 必须与锁同样按陈旧判定回收**：否则「持锁实例在接管流程中被 SIGKILL」留下的 claim 会永久封锁接管——插件永久停在只读镜像态、不再采集新用量（面板看着正常，数据悄悄停更），且占着锁别人也进不来。claim 的删除也不得抛出（残留由下一次接管按陈旧判定回收）。

**归属校验要节流**：读锁文件 + `JSON.parse` 实测占 `append` 总成本约 61%（2000 次 append 里 975ms 花在校验），回填 10 万条要多花约 50s。节流依据用**锁文件指纹**（mtime+size）而非固定时间窗：锁被接管时指纹必然跳变，立刻触发重新校验，不存在「窗口内漏检易主」的窗口（比纯时间窗更严谨）。指纹读取只是一次 `stat`，比读+parse 便宜一个数量级。

## 4. 日聚合

```json
{"version":1,"date":"2026-10-03",
 "byModel":{"deepseek/deepseek-chat":{"uncachedInputTokens":n,"outputTokens":n,"cacheReadTokens":n,"cacheWriteTokens":n,"samples":n,"turns":n}},
 "byHour":[24 个数——每小时四桶之和],
 "sessions":{"<sid>":{"firstMs":n,"lastMs":n}}}
```

模型 key = `"<provider>/<model>"`。`turns` 计数：`kind==="add"` 且该 `(sessionId, turn)` 当日首见才 +1（按 seen 集全局去重，与模型无关）。全项目统一口径 `totalTokens` = 四桶之和（`uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`），与官方 trajectory「用量」四项可逐项对账。

**归轮按到达顺序**（增量路径与重建路径必须同口径）：增量侧按 append 到达顺序记首见；重建侧也按 records 的**行序**遍历，**不按 `time` 排序**。排序会让「同一轮换模型续采」时轮数归属的模型在重建前后漂移，daily 对不上账。同一天的 records 必在同一月份文件内，文件行序 = append 序 = 到达序。

日聚合可随时由 records JSONL 全量重建（`rebuildDaily(records)` 纯函数）。**重建触发判据不能只看日期集**：

| 判据 | 含义 |
|---|---|
| ① `produced > 0` | 本轮回填补了记录 |
| ② 日期集不一致 | daily 缺档/多档（崩溃窗丢档、手工删档） |
| ③ **内容判据** | 某日 daily 的 `samples` 总数 ≠ 该日 records 条数 → 该日 daily 陈旧 |

只比日期集的话，「回填中途被杀（records 已写、末尾重建未跑）」会留下日期集一致但内容为空的 daily，此后每轮 `produced=0` 且日期集一致 → 永不重建 → 面板长期显示「暂无使用数据」，真源数据被永久埋在 records 里。

`seenTurns` 必须**从当日 records 反推复原**（不能恒为空集）：否则进程重启后同一会话同一 `(sid,turn)` 再次产生 `kind==="add"` 的 record 会被二次计轮（真实只有 1 轮，热力图 tooltip 轮数虚高），且错值会随 flush 落盘长期保留。取当日 records 时须排除正在追加的那一条（否则本轮的 +1 会被吞）。

盘上 daily 形状可能残缺（手改/旧格式/截断后恰好是合法 JSON）：读入时须归一化到当前形状（缺 `byModel`/`byHour`/`sessions` 补默认值），否则增量路径写到 `undefined` 上抛错，且该日 daily 永不落盘。

**重建必须逐日错误隔离**：daily 只是缓存，某日写失败只降级该日缓存，不得冒泡成「回填失败」并中断后续所有日期的重建（真源 records 明明在盘上）。重建成功后**无条件写入 `dailyCache`**：否则历史日期不进缓存，每个 API 请求都要回磁盘读全部日档（366 天 ≈ 160ms/请求，随历史线性增长）。

**records 的时间戳必须数值化后校验**：纯数字字符串（外部工具导出常见）能通过 `Number(time) > 0` 的过滤，但 `isoOf(字符串)` 走 Date 的字符串解析 → Invalid Date → 索引键变成 `"NaN-NaN-NaN"` → `writeDaily` 抛「非法日期」→ 整轮重建中断。写入路径（`appendRecord`/`indexRecord`/`ensureRecordsIndex`）统一 `Number(...)` + 有效性校验。

**负桶不钳零，负值在展示层挡**：replace 差值可以为负，「自然抵消」正是对账基础（§2），钳零会让跨午夜的 replace 差值被丢掉、总量反而多算。负值只可能来自「add 落前一天、replace 落后一天（跨午夜）」的归日错配——真源与 daily 保持真实累加，防御放在 client 侧：`modelValueOf` 取 `max(0, ·)`（否则负 Y 冲出视箱）、命中率钳到 `[0,100]`。

## 5. HTTP API

路由挂在宿主内核 webServer 下，loopback 守卫（仅放行本机请求，读路由放行 GET/HEAD）：

| 路由 | 入参 | 响应 |
|---|---|---|
| `GET /api/dsh-usage-stats/summary` | — | `{since, totalTokens, peakDay:{date,tokens}|null, longestChatMs, currentStreakDays, longestStreakDays, cacheReadTokens, uncachedInputTokens, cacheHitRate}` |
| `GET /api/dsh-usage-stats/heatmap` | `?days=N`（默认 366，0=全量，上界 3660） | `{days:[{date:"YYYY-MM-DD", tokens, turns}]}` 逐日全量；weekly/total 列聚合由 client 计算 |
| `GET /api/dsh-usage-stats/trend` | `?days=1\|7\|30` | days=1 → `{granularity:"hour", points:[{label:"0时"…"23时", byModel:{key:tokens}, total}]}`；否则 `{granularity:"day", points:[{date, byModel, total}]}` |
| `GET /api/dsh-usage-stats/models` | `?days=0\|7\|30`（默认 0=全期） | `{models:[{key, provider, model, tokens, share}], total}`，按 tokens 降序。模型用量环图恒用 `days=0` 全期口径，**全期两端都不设界**（与 `summarize` 的全期求和同口径，否则未来时间戳的记录会让环图总量小于摘要条累计） |
| `GET /api/dsh-usage-stats/backfill/status` | — | `{running, startedAt, scanned, total, backfilled, records, lostFrames, finishedAt, error}` |
| `POST /api/dsh-usage-stats/backfill` | — | 202 受理制：`{ok, started:true}` 即返，任务后台分片执行；并发触发返回 409 |

`days` 参数上界：越界的值会让起点算成 `"NaN-NaN-NaN"`，所有日期被过滤 → 热力图静默空白且无任何报错。故 heatmap 的 `days` 钳到 3660。

摘要条口径：`totalTokens` 全期求和；`peakDay` 为单日四桶之和最大的一天；`longestChatMs` 按 `(sessionId, date)` 分桶取 `lastMs-firstMs` 的全期最大值（跨日会话按日截断，近似）；`currentStreakDays` 为「今天有用量=1，往回连续有用量天数」（今天没有则从昨天往回数），`longestStreakDays` 为历史最长；`cacheHitRate` 为缓存命中 Token ÷（缓存命中 + 未缓存输入）×100，无输入时为 `null`（前端显示「—」）。空数据返回 `totalTokens:0, peakDay:null, longestChatMs:0, streak:0, cacheHitRate:null, since:当天`。

**读面不得依赖 daily 缓存可写**：daily 只是缓存，写失败只降级缓存本身，不能冒泡成 500。`flushDirtyDaily` 逐日 try/catch，写失败保留脏标记待下轮重试——否则磁盘满/目录只读会让 `summary` 与 `heatmap` 全线 500，而真源 records 明明在盘上。

### 口径分层（重要）

页面上的四块数据口径各不相同，不可互相套用——

| 数据 | 口径 | 受「近 7 日 / 近 30 日」影响 |
| --- | --- | --- |
| 摘要条六格 | 全期 | 否 |
| Token 活动热力图 | 最近 52 自然周 | 否 |
| 每日 Token 趋势图 | 近 7 日 / 近 30 日 | **是** |
| 模型用量环图 | **全期** | 否 |

## 6. 面板 UI 与交互

UI 描述以本节为准。面板挂在设置页 `settings.section`，`order: 13`，label「使用统计」，标题右侧带「应用用量」徽章。

硬性要求：

1. 样式全部 `dus-*` 前缀命名空间，零官方类名依赖；双主题跟随官方 theme（`body` / `body[data-ds-dark-theme]` 两档 CSS 变量）。
2. 六块 UI：
   - **六格摘要条**：`repeat(auto-fit,minmax(132px,1fr))` 自适应折行，标签不截断；分隔线用「1px 列间隙 + 格子外扩阴影（`box-shadow:1px 0 0`）」画——折行后行首无孤线（画在 border 上必然在行首/行尾留线），末列阴影溢出 1px 由 `overflow:hidden` 裁掉。
   - **热力图**：52 自然周列、周日起、`repeat(52,minmax(0,1fr))` 等分无滚动、`ceil(v/max*4)` 五档、每日/每周/累计三档切换、每周/累计为列底对齐色块柱、无图例。
   - **时间范围胶囊**：近 7 日 / 近 30 日，默认近 30 日；标题行文案「时间范围」；**只作用于趋势折线**。
   - **趋势折线**：单调三次插值 Fritsch–Carlson（切线 = 3× 相邻段斜率限幅，遇重复横坐标 `dx<=0` 置 `s=0` 防 NaN）；Y 域 `[0, 单模型单日峰值]`（独立折线不是堆叠图，拿日总量当域会把多模型压扁到底部）；Y 轴隐藏；X 刻度 ≤14 全标否则首尾每 5；tooltip 卡片「{月日} - {总量} tokens」+ 分模型行，8px 圆点 + 名称 + mono 数值 +「tokens」单位，0 用量行过滤。
   - **模型环形图**：半径 rO=76 / rI=50.4（200 视箱）、paddingAngle 2、中心总量、右侧图例色块 + 等宽名 + 百分比 + token 数、超 6 个归并「其他模型」；tooltip 第二行写「全部用量」。
   - 右下刷新按钮。页面不提供「回填历史」入口（回填由宿主装载时自动触发）。
3. 三态：加载（骨架或文案）/ 空态 / 错误态（重试按钮）。单路 fetch 失败只降级对应卡片并给行内「重试」，不炸整面板。**降级行的出现与否只看「该路本轮是否失败」，与是否已有旧数据无关**——已有旧数据时也要显示「未更新，显示为上次数据」+ 行内重试按钮（否则用户无法判断哪一块陈旧）。
4. 数字格式化：`≥1 万` 显示「x.x 万」、`≥1 亿` 显示「x.x 亿」（万档四舍五入后 ≥10000 改走亿档）。**页面上所有 token 数值一律走万/亿简写**（热力图 tooltip、趋势 tooltip 标题与明细行、环形图中心与列表、环形 tooltip）；完整千分位只出现在元素的 `title` 悬停说明里。
5. 静默轮询：60 秒一拍，拉 summary + 当前 range 的 trend + models（全期口径，与 range 无关但会随新会话增长），不闪「加载中」，后台标签页跳拍、切回前台补一拍、关页面即停。热力图按需刷新：当且仅当本拍 summary 的 `totalTokens` 或「今天」与上一拍不同时追加一次 heatmap；**热力图从未拿到过时必拉**（否则「按需补拉」永远等不到「总量变了」这个信号，热力图会永久停在「加载中…」）；拉失败不推进判定基线（否则判定信号被消费、热力图静默冻结）。
6. 「更新于 HH:MM」仅在同一拍内实际发起的每一路都成功时推进；有路失败则冻结时间戳并追加「（部分数据未更新）」。**首拍即失败时还没有时间戳**：此时也要给出「尚未取得数据（部分数据未更新）」的可见信号，否则页脚整格消失，用户无法区分「没数据」与「服务挂了」。
7. phase 转移：初始加载与显式刷新（`full`）全权转移；静默拍单调——`prev==="ready"` 恒保持 ready，`next==="ready"` 且 prev 非 ready 时升为 ready，其余 no-op。静默拍永不进 `loading`、不打回 `empty`/`error`；被新拍顶掉的初始拍至少要把面板从 `loading` 放出。
8. **判废按 key 而非整包**：每一路（summary/heatmap/trend/models）各自记录最新 seq，落地时逐路比对——某一拍被后发起的拍顶掉时，只丢它「比别的拍更新」的那几路，别的路（如 full 拍的 heatmap）仍可落地。整包丢弃会让「初始加载 >60s」或「刷新与静默拍撞车」时热力图永久停在「加载中…」（既无降级行也无重试出口），表现为「点了刷新没反应」。
   **seq 登记必须在 `await` 之前且只许递增**：若等响应回来才登记，慢请求完成后会覆盖快请求已登记的 seq，令过期响应被误判为「这一路最新」而落地（数据回退）。
9. 键盘可达：热力图与趋势图各只占一个 tab stop（容器 `tabIndex=0`），聚焦后用方向键移动游标并复用同一数据卡片；只接管 ← → ↑ ↓ Home End 六键，其余（含 Tab）不拦截；首次按键游标落在今天（热力图 `51*7 + 星期几`）/ 最新一点；游标只存索引（像素锚点渲染时现算），热力图游标格加 `.dus-hmCur` 描边（缺勤日也可见）；胶囊补 `aria-pressed`，可点元素补 `:focus-visible`，图表容器补 `role="img"` + `aria-label`（热力图「共 N 天有用量」从原始逐日数组算，避免读到柱格数）。
10. 趋势图例**纯展示**：全部模型恒定列出，不可点击隐藏/恢复（`<span>` 渲染，不可聚焦不可点击）。趋势卡片行数封顶 8 行 + 「另有 N 个模型未列出」。
11. 悬停卡片使用自定义浮层（非原生 `title`）：分侧定位并钳位到容器内，环形图定位容器为整行 `.dus-donutRow`；`.dus-tip` 用 `box-sizing:border-box` + `max-width:calc(100% - 16px)` 保证钳位数学不失真。**纵向高度按实际行数估算**（`tipHeightOf(n)`），用常量高估会让卡片整体偏高 50~90px，出现「卡片飘在别处」的错位感。
12. 回填进度**全程可见**：挂载即读一次 `GET /backfill/status`，`running=true` 进入跟踪态；跟踪走单一 ticker（800ms 一拍，布尔判据防重入）。`running` 由 true 转 false 且确实观察到过 true 才做一次全量刷新；`status.error` 非空即显式失败文案。**ready 态下也显示跟踪进度**（否则用户在整个回填期间看不到任何提示）。**空态期间补读一次状态**：挂载那一刻可能正好错过 `running=true`（宿主用 `setImmediate` 触发自动回填，running 标记在 `runBackfill` 内部才置位），此后若无补读就永远进不了跟踪态——回填完成后也不会触发那次全量刷新。
13. 界面文案逐字定稿（测试断言以此为准）：空态 `暂无使用数据`、`开始对话后这里会显示 Token 活动与模型用量；若刚装上插件，历史会话会在后台自动补进来。`；跟踪中 `正在回填历史会话…`、`已扫 {X}/{Y} 会话，完成后这里会自动显示统计。`；完成 `回填完成：补了 {N} 个会话、{R} 条记录。`；失败 `回填失败：{原因}`；全失败态 `加载失败` / `统计服务暂时不可用，请稍后重试。`；摘要条标签 `累计 Token 数` / `峰值 Token 数` / `缓存命中率` / `最长聊天时长` / `当前连续天数` / `最长连续天数`；缓存命中率无输入时显示 `—`。
14. 纯函数直测面：`__pure` 导出折叠与 UI 的算术、布局与转移逻辑，供单元测试直接调用。
15. **配色与主题**（参照 ZCode「使用统计」面板的变量表，深浅两档各自成体系）：

    | 用途 | 深色档 | 浅色档 |
    |---|---|---|
    | 图表色 1 | sky-600 `oklch(58.8% .158 241.966)` | sky-500 `oklch(68.5% .169 237.323)` |
    | 图表色 2 | teal-600 `oklch(60% .118 184.704)` | teal-400 `oklch(77.7% .152 181.912)` |
    | 图表色 3 | violet-600 `oklch(54.1% .281 293.009)` | violet-400 `oklch(70.2% .183 293.541)` |
    | 图表色 4 | rose-500 `oklch(64.5% .246 16.439)` | rose-400 `oklch(71.2% .194 13.428)` |
    | 图表色 5 | indigo-500 `oklch(58.5% .233 277.117)` | indigo-400 `oklch(67.3% .182 276.935)` |
    | 图表色 6 | cyan-600 `oklch(60.9% .126 221.723)` | cyan-400 `oklch(78.9% .154 211.53)` |

    - 六色按模型下标循环取用（第 7 个模型复用色 1），图例色块与曲线描边同源。
    - **热力图五档用「蓝 × 空格子底」混合**（`color-mix`）：0 档是空格子底色（深色 `rgba(255,255,255,.075)`、浅色 `rgba(0,0,0,.05)`），1~4 档按蓝的占比 18/36/58/82%（深色）与 24/42/62/78%（浅色）混合。**0 档必须与卡片背景有可见反差**——否则深色主题下整张网格「消失」（这是踩过的坑）。
    - 热力格为纯色圆角方块、**不描边**（与 ZCode 一致）；保留 1px transparent 作占位，防有无数据时尺寸跳动。
    - 主题载体沿用宿主的 `body[data-ds-dark-theme]`：浅档变量挂在 `body`，深档在该属性下覆盖，两档同名同义。
16. **趋势图 Y 轴按量级自动切换刻度**：
    - 线性轴在量级悬殊时会让小模型彻底消失——单模型峰值 27.5 亿时，33.5 万的小模型高度只剩 0.12%，全部贴在 0 轴上，图例列出 7 个模型却只看得到 1 条线（与「全部模型都要展示」冲突）。
    - 判据：峰值与「最小非零值」之比超过 50 倍即改用**对数轴**（`log1p` 软化，0 值仍映射到底部，不产生 `-Infinity`）；量级接近时仍用线性轴（线性更好读）。
    - 软化因子取**最小非零值**：`log1p(1)=0.693` 保证最小的模型也有约 8% 高度（8200 倍量级时），不会贴底。
    - 补 Y 轴刻度标签（紧凑写法）。**不在标题旁标注「对数刻度」**——按产品要求，趋势图与模型用量卡都不带口径标记。
    - 刻度数封顶 5 档：240px 高的图放 12 个标签会挤成一团。
17. **国际化（跟随宿主语言）**：
    - 宿主提供 `@deepseek-ai/dsh-client-locale`：客户端注册 `ctx.locale.register(ns, {zh, en})` 取字典，组件注册项声明 `locale: "<ns>"` 后宿主注入 `t` prop。
    - **字典在 `lib/locale.js`**（命名空间 `dsh-usage-stats`），中英两套 key 必须**完全一致**、占位符集合逐 key 一致（`test/locale.test.mjs` 守护）。
    - **组件内文案一律走宿主注入的 `props.t`**：`t` 的引用随语言切换而变，React 因此自动重渲染，**无需刷新页面**。用 `ctx.locale.bind()` 拿到的稳定引用不会触发重渲染，只能用于「宿主在渲染时求值」的场合（如分区 `label`）。
    - **纯函数**需要文案时把 `t` 作为最后一个可选参数，缺省用 `lib/locale.js` 的 `fallbackT()`（中文兜底）——直测面因此不依赖宿主，输出与中文版逐字相同。
    - 宿主在当前语言查不到 key 时回退到 key 本身；本插件的兜底翻译器行为与之对齐（不会漏显文案）。
    - 数字与日期格式（万/亿、天/小时/分、月/日）也走字典：英文版用 `K`/`B` 与 `h`/`min` 口径。
    - **日志与诊断信息保持英文**：`console.warn` / `console.error` 是给开发者看的，不属于界面文案，不进字典。


## 7. 索引与回填

- 采集：`session/event` → `fold.apply` → 有增量则 `store.append(record)`（含 `seq`），同步维护日索引与当日 daily 缓存（防抖 2s 合并写）。
- 记账水位从 records 推导（按 sessionId 聚合 `max(seq)`，records 为唯一真源，SIGKILL 无丢失窗）；live 侧不写 marker。marker 中的 `watermarks` 语义收窄为「bootstrap 基线」，仅 mtime 哨兵与空会话分支写入起点 seq；读旧版文件时其 watermarks 整包并入基线（取大，向后兼容）。
- 回填：`node:zlib` 逐帧解压多帧 zstd 会话文件，递归扫 `~/.dsh/sessions/<workspace编码目录>/<sessionId>/session.v*.jsonl.zstd`；筛四类事件喂同一 fold 状态机（全文件重放以保槽基线），只落 `seq > 水位` 的增量 record。async 分片（每 4 会话让出一拍），动态 foldStates 守卫挡 live 交错。
- 触发：装载即自动回填一轮（幂等增量，按 marker.done/水位跳过）；进度经 `GET /backfill/status` 轮询，失败信号经 `error` 字段直达面板。`POST /backfill` 保留为宿主侧接口（供外部触发），面板不提供手动按钮。
- **降级中止**：回填循环体内检查写者身份——锁易主发生在回填中途（每 4 会话让出一次）时，已降级实例必须停止写盘，否则与新持有者并行记账（双计）。中止前补写一次全量 marker（降频写盘意味着已折会话的 done 可能还没落盘）。
- **卸载中止**：关停清理的第一件事是放弃写者身份（`writer = false`），在途回填据此自行中止——否则卸载后回填继续解压剩余会话文件（纯 CPU/IO 空转，且每会话一条 warn 噪音）。
- **mtime 哨兵的落盘条件要区分两种「零产出」**：①无增量（本会话已折过、此次没有新东西）→ 写 done+mtime，让哨兵生效，下次直接跳过解压；②有增量但 append 全失败（写盘故障窗）→ **不写**（含 done），否则 mtime 哨兵把故障固化、恢复后永不补。只更新局部 `done` 集合而不同步 `markerDone` 会让哨兵永远不落盘，该会话每轮都被重复解压。
- **marker 降频写**：marker 是全量快照，每会话写一次 = O(n²)（3000 会话实测 7.2s / 单文件 314KB；1 万会话约 24s、累计写盘约 1GB）。降频为每 50 会话一次，循环收尾与降级中止时补一次全量。降频**安全**：记账水位由 records 推导，崩溃后重折同一会话不会双计（只是白折一遍）。

## 8. 测试要求

- `node --test`，文件名 `*.test.mjs` 放 `test/`；所有 options 对象必须位于第二参位（第三参会被 node:test 静默忽略）。
- 每个异步测试显式 `{timeout: 5000}`；临时目录用 `mkdtemp` 创建并在 `finally` 清理。
- 断言用 `node:assert/strict`。
- 写路径的测试必须先 `acquireLock()`——未持锁时 `append` 会因归属校验被拒（这是有意的幽灵写者防线）。
- 事件时间戳必须落在热力图回看窗口（366 天）内，否则该日不在 `heatmap` 结果里。**用「相对今天」构造时间戳**（`daysAgoAt(n)`），不要硬编码日期——硬编码到期后测试会集体变红。
- **断言必须真的会因为实现改坏而失败**。三类典型假阳性要避免：
  - `react.createElement(Comp, props)` **不执行组件函数体**——渲染冒烟必须**直接调用** `Comp(props)`，否则组件内的一切都测不到。
  - 恒真断言（如 `typeof x === "object"`、两个由测试自己算出的数比较）等于没断言。
  - 把关键断言包在 `if (existsSync(...))` 里——条件不成立时整段变死代码。
- 断言「四桶求和」要用四桶 helper，不能只加 `uncachedInputTokens` 一个桶（其余三桶恰为 0 时才巧合成立，换个夹具就量纲错配）。

## 9. 已知局限性

- live 折叠槽在内存，进程重启即弃：替换窗横跨重启时旧样本被双计，极罕见。
- 回填路径 attempt 样本的模型归属依赖会话内 `request/header` 前置，缺失时记 unknown。
- 最长聊天时长按（会话, 日）分桶取极差，跨日会话按日截断，是近似口径。
- 少数「有水位无 mtime」的历史会话每次装载仍需解压（约 0.7~4 秒）。
- 多帧 zstd 帧边界靠魔数扫描，理论上有极低概率误报；解压失败帧跳过并计数留痕。
- 热力图固定回看 52 自然周，更早用量只计入摘要条等全期口径；「每周/累计」档悬停卡片取该周末位日期与周合计。
- 趋势悬停卡片最多列 8 个模型行，超出注「另有 N 个模型未列出」。
- 推导水位按 `max(seq)` 聚合，若插件在会话中途启用，live 侧先记了高 seq 事件会越过文件前段 → 该段历史用量永久缺失（宁漏勿双计的取舍）。
- 回填读到的会话文件落后于 live 已见事件时，继承的槽基线可能比 live 旧 → 该 `(turn,step)` 的替换差值基准略有偏差。
- `modelShares` 以当天封顶而 `summarize` 不封顶：若存在未来时间戳的记录（时钟漂移），模型环图总量会略小于摘要总量。
