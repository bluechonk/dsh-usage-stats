# 代码审核报告

本文件记录 2026-10-20 对全项目代码的一次严格审核，以及随后的修复。审核范围：`lib/fold.js`、`lib/store.js`、`lib/aggregate.js`、`lib/index.js`、`lib/client.js` 全部五个源文件，以及全部测试。

审核方式：逐行阅读 + 对每条可疑点构造最小复现（用 mock ctx 驱动真实 `apply()`、真实 store、真实 HTTP 路由），只报能复现或能静态证明的问题，不报命名风格一类的主观项。

## 一、已修复的问题

### 1.1 Host 侧：写锁语义（最严重的一组）

这组问题会直接导致**双实例互抹账本**——两个 DSH 实例同时写同一份统计数据。

| # | 位置 | 问题 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| 1 | `store.js` `acquireLock()` | 降级后 60s 重试抢锁时 `lockHeld` 仍为 `true`，函数直接 `return`，根本没去抢锁 | 调用方误判自己仍是写者，与真持有者并行写 → 双计 + 互抹账本 | 改为**以盘上 pid 为准复核**：归属已易主则清 `lockHeld` 并走真正抢锁流程 |
| 2 | `store.js` `append()` / `writeBackfillMarker()` | 都不校验锁归属（`touchLock` 只被 60s 心跳调用） | 锁被陈旧接管的 0~60s 窗口内，原写者仍能用陈旧内存快照覆写 `backfill-marker.json`，抹掉新持有者的 done/水位/哨兵 | 两个写入路径都前置 `assertOwnership()`，失败即拒写（`append` 返回 false，上层不推进记账水位） |
| 3 | `store.js` `acquireLock()` | 陈旧锁接管有 TOCTOU：`statSync → rmSync → wx` 期间，另一个实例可能刚建好新锁并被本实例删掉 | 两个实例都认为自己是唯一写者 | 用独占 `lock.claim` 文件给接管过程串行化，并在拿到接管权后复核 mtime 仍陈旧 |
| 4 | `store.js` `close()` | 锁文件读不到/解析失败时走兜底 `rmSync`，把「别人正在创建的半成品锁」删掉 | 等于给并发实例开闸 | 归属不可确认时**不删锁**，交给 5min 陈旧规则接管 |
| 5 | `index.js` 回填循环 | 降级后在途回填不中止（循环体内无写者判据） | 已降级实例继续写 records，与新持有者重复记账 | 循环体开头检查写者身份，降级即中止并写明原因 |
| 6 | `index.js` 心跳 | 只把 `LOCK_LOST` 当降级依据，其它失败静默忽略 | 锁文件损坏时继续以写者身份写，属 fail-open | 非 `LOCK_LOST` 的失败也记 warn；锁易主一律降级 |

### 1.2 Host 侧：日聚合正确性

| # | 位置 | 问题 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| 7 | `index.js` `dailyEntry()` | 复原 daily 缓存时 `seenTurns` 恒为空集 | 进程重启后同一会话同一 `(sid,turn)` 再次产生 `kind==="add"` 的 record 会被二次计轮（真实只有 1 轮），热力图 tooltip 轮数虚高，且错值随 flush 落盘长期保留 | 从当日 records 反推 `seenTurns`（排除正在追加的那条，否则本轮 +1 会被吞） |
| 8 | `index.js` `rebuildAllDaily()` | 条件重建只比「日期集是否一致」，不看内容 | 回填中途被杀（records 已写、末尾重建未跑）会留下日期集一致但内容为空的 daily，此后每轮 `produced=0` 且日期集一致 → 永不重建 → 面板长期显示「暂无使用数据」，真源数据永久埋在 records 里 | 增加内容判据：某日 daily 的 `samples` 总数 ≠ 该日 records 条数 → 该日陈旧，单独重建 |
| 9 | `index.js` `flushDirtyDaily()` | 写盘失败直接冒泡 | 磁盘满/目录只读会让 `summary` 与 `heatmap` 全线 500，而真源 records 明明在盘上 | 逐日 try/catch：写失败只降级缓存本身，保留脏标记待下轮重试 |
| 10 | `index.js` `ctx.effect` 清理 | `flushDirtyDaily()` 抛错会连带跳过 marker 落盘与 `store.close()` | **锁文件残留** → 下一个实例 5 分钟内抢不到锁，只能降级为只读镜像（面板无数据） | 各步独立 try/catch，锁无论如何都释放 |

### 1.3 Host 侧：健壮性

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 11 | `fold.js` 采样分支 | 顶层 `usage` 为 `null` 时整条样本被丢（不回落 stream 末块） | `null` 与缺省同义，都回落 stream 采样（原先的写法会把本可采到的用量整条漏计） |
| 12 | `index.js` heatmap 路由 | `days` 无上界，越界值让起点算成 `"NaN-NaN-NaN"` | 上界钳到 3660；`intParam` 增加 `max` 参数 |
| 13 | `index.js` `sanitizeErrorText()` | 只脱敏 Windows 反斜杠路径（遇空格即止），POSIX 路径完全不过滤 | 同时覆盖引号包裹路径、Windows 路径、POSIX 路径 |
| 14 | `index.js` `dailyEntry()` | 盘上 daily 形状残缺时增量路径写到 `undefined` 上抛错，且该日 daily 永不落盘 | 读入时归一化到当前形状（缺字段补默认值） |

### 1.4 Client 侧

| # | 位置 | 问题 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| 15 | `client.js` 静默拍 | 静默拍传 `chartsOnly: true`，而 `models` 的取用条件正是 `chartsOnly ? null : [...]` | 60 秒拍只拉 summary+trend，**模型用量环图在轮询路径上永不更新**；「更新于 HH:MM」照常推进 → 时间戳撒谎 | 区分「换档拍」与「静默拍」：静默拍恒拉 models（全期用量随新会话增长） |
| 16 | `client.js` 判废 | 判废粒度是「整趟 load」 | 初始加载 >60s 或刷新与静默拍撞车时，full 拍的 heatmap 被整包丢弃且静默拍不补 → 热力图**永久停在「加载中…」**（既无降级行也无重试出口），表现为「点了刷新没反应」 | 改为**按 key 判废**：每路各自记最新 seq，逐路比对落地；另加「热力图从未拿到过时静默拍必拉」兜底 |
| 17 | `client.js` 降级行 | 有旧数据时三块都不显示降级行（只看「该路本次是否失败」） | 用户看到的是「有数据的旧面板」，无法判断哪块陈旧，也拿不到行内重试入口 | 摘要条/热力图/趋势图/环形图统一加「未更新，显示为上次数据」+ 行内重试 |
| 18 | `client.js` 回填进度 | 只在空态可见 | ready 态下整个回填期间无任何进度提示 | 跟踪进度行与 phase 解耦，四个态都显示 |
| 19 | `client.js` 回填状态 | 只在挂载时读一次 | 挂载早于宿主启动自动回填时永远错过 `running=true` → 进不了跟踪态，回填完成后也不触发全量刷新 | 空态期间补读一次状态 |
| 20 | `client.js` tooltip 高度 | 热力图/环形图用常量 `TIP_H=120` 估高 | 卡片整体偏高 50~90px，「卡片飘在别处」 | 改用 `tipHeightOf(行数)` 按实际行数估算 |
| 21 | `client.js` `donutRowsOf` | `models` 数组里的 `null` 元素会抛 TypeError | 一处脏数据炸掉整个面板（被错误边界接住，全页变兜底横幅） | 坏元素直接跳过 |
| 22 | `client.js` 页脚 | 首拍即失败时 `updatedAt` 仍为 null，页脚整格不渲染 | 「（部分数据未更新）」这个唯一的服务不可用提示一起消失 | 时间戳缺席时也给出「尚未取得数据（部分数据未更新）」 |
| 23 | `client.js` 环形图尺寸 | 代码 96/63.4（240 视箱）与 SPEC 明文 76/50.4 不符，测试又按 76/50.4 断言 | 常量、SPEC、测试三处口径不一致 | 统一为 SPEC 值（200 视箱 / 76 / 50.4） |

### 1.5 死代码与过时注释

- 删除 `client.js` 的 `DONUT_MERGE`（声明后从未使用，归并阈值硬编码在别处，是改阈值时的陷阱）。
- 删除 `client.js` 的 `visibleRows` 冗余别名（图例改为纯展示后恒等于 `modelRows`）。
- 删除 `index.js` 的 `allRecords()`（零调用点）。
- 重写 `client.js` 文件头注释：「五格摘要条」「今日档」「千分位」「图例点击隐藏」等改版前的事实全部过时——注释与实现互相矛盾正是问题 15 的成因。
- `client.js` 区块注释「A1 五格摘要条」→「A1 六格摘要条」。
- `store.js` `hasAnyRecords()` 保留（公开 API + 测试覆盖），补注释说明它已不是回填触发判据。

## 二、经审核确认无误（记录在案，避免重复排查）

**Host 侧**

- loopback 守卫不可绕过：remoteAddress 白名单 + Host 主机名白名单 + `sec-fetch-site: cross-site` 拦截 + Origin 必须同源；仅 GET/HEAD 放行。
- 无路径穿越：会话目录扫描的路径段全部来自 `readdir` 的真实目录项；daily 文件名有 `^\d{4}-\d{2}-\d{2}$` 兜底。
- 无命令注入面：五个源文件里没有任何子进程调用。
- 时区口径一致：`isoOf` 与 `monthOf` 都用本地时区分量，月轮转与日聚合口径一致；`addDaysIso` 靠 `Date.setDate` 归一化，无手写天数累加。
- 无除零：`cacheHitRate` 分母 0 给 `null`；`share` 分母判 `total > 0`。
- NaN 防护：fold 的四桶全量 `Number.isFinite` 校验，非法样本整条丢弃。
- fold 语义与 SPEC §2 伪码逐条一致。
- 原子写安全：tmp + rename 同目录同盘；tmp 残片名不匹配正名规则，不会被当正式档。
- 防抖合写无竞态：只在 `appendRecord` 里建 timer，回调与 `consistentDailies` 都同步跑 flush。
- live 与回填不双计（主路径）：让出点在取样与守卫之前，处理段无 await（原子窗）。
- `session/disposed` 事件真实存在，fold 状态清理有效，不会无界增长。

**Client 侧**

- Hook 顺序稳定（无「hook 藏在 if 里」），依赖数组完整，无过期 state 闭包（range 走 ref）。
- 所有数组子元素有稳定 key，游标移动不会导致焦点元素卸载（focus 不丢）。
- 事件监听与定时器全部清理（`visibilitychange`、`setInterval`、回填 ticker），卸载后无 setState。
- phase 状态机无卡死路径：全失败 → error 态并给出重试按钮。
- tooltip 横向钳位数学正确，坏输入兜底不产 NaN。
- a11y 六键与 aria 全套落实。
- **无 XSS 面**：全文件无 `innerHTML` / `dangerouslySetInnerHTML` / `document.write`；用户与服务端数据全部经 React 文本节点或 `title` 属性输出。
- SVG 路径坐标不会出 NaN/Infinity。

## 三、第二轮审核（2026-10-20 晚）

第一轮修完后又做了一轮，重点是「修过的有没有引入新问题」「测试到底有没有在测东西」「第一轮标为可忽略的到底该不该修」。

### 3.1 修复的问题

| # | 位置 | 问题 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| R1 | `aggregate.js` `modelShares` | `days=0`（全期）仍按当天封顶，而 `summarize` 不封顶 | 未来时间戳的记录（时钟漂移）被这里排除却被摘要条计入 → **环图总量 < 摘要条累计**（口径对不上，正是「模型用量」最该避免的事） | 全期口径两端都不设界 |
| R2 | `aggregate.js` `rebuildDaily` | 归轮按 `time` 排序，增量路径按**到达顺序** | 「同一轮换模型续采」时轮数归属的模型在重建前后漂移，daily 对不上账 | 重建改按到达顺序（同一天的 records 必在同一月份文件内，行序即到达序） |
| R3 | `client.js` 判废 | 每路 seq 的登记写在 `await Promise.allSettled` **之后** | 并发拍下慢响应后完成会覆盖快响应已登记的 seq → **过期响应被误判为「这一路最新」而落地**（数据回退） | 登记移到 await 之前，且只许递增 |
| R4 | `index.js` 回填主路径 | 无增量时只 `done.add()`（局部集合），`markerDone` 未同步 | 该会话的 done 与 mtime 哨兵都不落盘 → **每轮回填都重复解压它** | 区分「无增量」与「增量全写盘失败」：前者写哨兵（稳态零解压），后者不写（避免固化故障窗） |
| R5 | `test/` 覆盖盲区 | 四条只读路由的响应形状无逐字段守护 | 后端改字段名不会被发现（client 侧静默拿 undefined） | 新增 API 契约测试（字段名/类型/取值域 + 「环图总量 === 摘要条累计」） |
| R6 | `test/` 回归防线 | 判废的 seq 登记顺序无守护 | R3 这类竞态可再次引入 | 新增源码级顺序断言（登记早于 await + 只增不减），已验证注入回归后会变红 |

### 3.2 复查后确认无需改动的

| 项 | 结论 |
| --- | --- |
| `fmtCompact` 的万/亿切换边界 | 1e8 恰好 → 「1 亿」；9999.95 万 → 「1 亿」；9999 → 「9999」；负数/NaN/Infinity → 「0」。已有测试逐值钉死 |
| 内存增长 | `foldStates`/`inheritedStates`/`lastRoute` 有 `session/disposed` 清理；`dailyCache` 按天有界；`derivedWatermarks` 随索引重建。无明显泄漏 |
| 原子写的 tmp 名 | 含 pid，跨进程/跨 store 实例不冲突；残片名不匹配 `DAILY_RE`/`RECORDS_RE`，不会被当正式档 |
| `assertOwnership` 每次 append 读一次锁文件 | 同步小文件读，高频事件下开销可接受；安全优先，保留每次校验 |
| live 侧缺 `event.time` 用 `Date.now()` 兜底、回填侧跳过 | 两侧不一致但**不会双计**（live 记过则水位已推、回填跳过；live 没记则两边都不记）。DSH 的 `session/event` 恒带 `time`，该分支实际不可达。改成回填也兜底会把历史记到今天，改成 live 也不记会丢真实用量——两边都不改 |
| `test31` 自定义封装 | 只是把超时放宽到 10s（集成测试要解压会话文件），**不吞断言失败** |
| `validOf` 的宽松校验 | 只校验关键字段存在是对的——不该因附加字段缺失就整块降级；字段名漂移由新增的 API 契约测试守护 |

## 四、留给后续的已知问题

以下问题经审核确认存在但**风险可控或改动面过大**，本次未修，已记入 [SPEC.md §9](../SPEC.md)：

| 问题 | 风险 | 未修原因 |
| --- | --- | --- |
| 推导水位按 `max(seq)` 聚合，插件在会话中途启用时该会话前段历史永久缺失 | 低 | 修它要拆开「回填水位」与「live 去重水位」两套语义，改动面大；当前是「宁漏勿双计」的取舍 |
| 回填读到落后于 live 的会话文件时，继承的槽基线可能比 live 旧 | 低 | 极端时序（文件落盘滞后）；偏差仅影响该 `(turn,step)` 的替换差值 |
| `modelShares` 以当天封顶而 `summarize` 不封顶 | 极低 | 需先有未来时间戳的记录（时钟漂移）才会显现 |
| `rebuildDaily` 按 time 排序归轮、增量路径按到达顺序归轮 | 极低 | 同一轮换模型续采时轮数归属的模型可能不同，轮总数一致 |
| live 侧缺 `event.time` 时用 `Date.now()`，回填侧直接跳过该事件 | 极低 | 两侧不一致但不会双计 |

## 四、审核后的测试规模

| 文件 | 用例数 | 覆盖重点 |
| --- | --- | --- |
| `test/fold.test.mjs` | 10 | 折叠语义五类 + retry 清槽 + `usage:null` 回落 |
| `test/store.test.mjs` | 14 | 落盘纪律、原子写、月轮转、锁互斥/陈旧接管/归属校验 |
| `test/aggregate.test.mjs` | 25 | 聚合口径：streak、峰值、缓存命中率、`days=0` 全期、归轮顺序 |
| `test/client.test.mjs` | 58 | 纯函数直测面（29 个）+ 版式回归 + 渲染冒烟 + 判废顺序 |
| `test/integration.test.mjs` | 25 | 端到端：回填不双计、锁易主降级、重启不重复计轮、daily 陈旧自愈、mtime 哨兵、API 契约 |
| `test/contract.test.mjs` | 8 | fold / zstd 帧 / fork 去重 / 配置解析的契约 |
| 合计 | **138** | `npm test` |

验证手段三层：

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 纯函数与契约 | `npm test` | 算术、布局、口径、接口形状 |
| 端到端（真实会话文件） | `npm run verify:e2e` | 真实回填 → 四条 API 响应形状 |
| 真机 UI（真实浏览器） | `npm run verify:ui` | 真实渲染路径：组件渲染、配色、按钮、控制台错误 |

