// dsh-usage-stats host 半边 —— 事件采集 → fold 折叠 → JSONL 落盘 → 四条只读 GET API → 历史回填。
// 采集面（实证 0.2.0-rc.2）：ctx.on("session/event", (session, event) => …)；
//   事件行形状 {type, seq, time, data}（实测会话文件逐字段核实）；time=epoch ms 是 record 时间戳来源。
// 折叠语义照抄 @deepseek-ai/dsh-token-meter tokenUsage 投影（lib/fold.js，五类语义用例在 test/fold.test.mjs）。
// 回填面（实测得出的三条硬事实）：
//   ① session.v4.jsonl.zstd 是**多帧 zstd 拼接**（每帧一个追加块，2.8MB 文件实测 876 帧，
//      帧间以 magic 28 B5 2F FD 分隔；node:zlib 的 *Sync 只解第一帧）——必须逐帧解。
//   ② fork 去重有源码级标记：内核 buildForkSeed 在继承前缀末尾插入
//      {type:"session/end-seed", data:{inherited:true}}，其 seq 之前（含）全部是父会话复制事件，
//      只统计 marker 之后的事件即可无双计（dsh-session/lib fork.ts 坐实）。
//   ③ assistant/message 的 source={kind,provider,model,replayState}——replayState 是每个
//      pi-ai 消息的常规字段，**不是** fork 标记（勿拿它去重）。
// 记账水位：records 是唯一真源——每条 record 带事件 seq，水位=按 sessionId
//   聚合 max(seq) 从 records 推导；marker 只存「无法从 records 推导的东西」（done / bootstrap
//   基线水位 / mtime 哨兵），live 完全不写 marker。SIGKILL 无丢失窗论证：崩溃窗丢的只是内存态，
//   重启从 records 推导水位，而 records 每条经 appendFileSync 同步落盘——推导水位天然已含崩溃前
//   全部已落盘 record，无丢失窗（这正是从 records 推导水位、不为 live 单独落盘水位之处）。
// 回滚：plugin remove（或 cordis patch enabled:false）；数据目录 ~/.dsh/usage-stats 整体可删。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createFoldState, applyEvent } from "./fold.js";
import { createStore } from "./store.js";
import {
  addDaysIso,
  emptyDaily,
  heatmapDays,
  isoOf,
  modelShares,
  rebuildDaily,
  summarize,
  trendPoints,
} from "./aggregate.js";

const name = "dsh-usage-stats";
const inject = ["webServer"];

const API_BASE = "/api/dsh-usage-stats";
const FOLD_EVENT_TYPES = new Set(["assistant/message", "assistant/attempt", "llm/retry-started"]);
const BUCKET_KEYS = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl\.zstd$/;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const DAILY_FLUSH_MS = 2000; // live 侧日聚合防抖合写
const LOCK_RETRY_MS = 60000; // 只读镜像接管写锁的重试周期
const LOCK_HEARTBEAT_MS = 60000; // 写者锁文件续期周期（须远小于陈旧判定 5min）
const KNOWN_SESSION_VERSION = 4;

/** 配置解析：未知键即抛（fail loud，同生态插件同纪律）。 */
export function resolveConfig(raw) {
  const value = raw !== void 0 && raw !== null && typeof raw === "object" ? raw : {};
  const KNOWN = new Set(["enabled", "storageRoot", "sessionsRoot"]);
  for (const key of Object.keys(value)) {
    if (!KNOWN.has(key)) throw new Error(`dsh-usage-stats: unknown config key "${key}"`);
  }
  const nonEmpty = (v, key) => {
    if (v === void 0 || v === null) return void 0;
    if (typeof v !== "string" || v.length === 0) throw new Error(`dsh-usage-stats: ${key} must be a non-empty string when set`);
    return v;
  };
  return {
    // 本插件只读事件+只写自有目录、无 LLM 调用，缺省开；关=显式 enabled:false
    enabled: value.enabled !== false,
    storageRoot: nonEmpty(value.storageRoot, "storageRoot") ?? join(homedir(), ".dsh", "usage-stats"),
    sessionsRoot: nonEmpty(value.sessionsRoot, "sessionsRoot") ?? join(homedir(), ".dsh", "sessions"),
  };
}

function makeLogger(ctx) {
  const debug = process.env.DSH_USAGE_STATS_DEBUG === "1";
  const emit = (level, message, error) => {
    try {
      if (debug) {
        console.error(`[dsh-usage-stats][${level}] ${message}`, error ?? "");
        return;
      }
      const logger = ctx.logger;
      if (logger !== void 0 && logger !== null && typeof logger[level] === "function") {
        logger[level](`[dsh-usage-stats] ${message}`, error ?? "");
      } else {
        (level === "error" ? console.error : console.warn)(`[dsh-usage-stats] ${message}`, error ?? "");
      }
    } catch {
      /* 日志永不炸主流程 */
    }
  };
  return {
    info: (m) => emit("info", m),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
  };
}

/** 错误文案脱敏：剥文件系统绝对路径——status.error 直达 client 面板，不泄本机目录结构。 */
function sanitizeErrorText(error) {
  return String(error?.message ?? error).replace(/[A-Za-z]:\\[^\s"]+/g, "<path>");
}

// ---- HTTP 守卫与写回 ----

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ---- 会话文件解压（多帧 zstd） ----

/** 扫描 zstd 帧边界（magic）。压缩数据里 magic 误报理论上存在，靠"解压失败即跳帧+计数留痕"兜底。 */
export function zstdFrameOffsets(buf) {
  const offsets = [];
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** 多帧 zstd 全量解压为文本。返回 {text, frames, lostFrames}；lostFrames>0 = 有帧解压失败被跳过。
 *  段落用数组收集最后 join：字符串 += 对大文件是 O(n²)（每次拼接复制整串）。 */
export function decompressSessionFile(buf) {
  const offsets = zstdFrameOffsets(buf);
  const bounds = offsets.length > 0 ? offsets : [0];
  const parts = [];
  let lostFrames = 0;
  const total = bounds.length;
  for (let i = 0; i < total; i += 1) {
    const end = i + 1 < total ? bounds[i + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(bounds[i], end)).toString("utf8"));
    } catch {
      lostFrames += 1;
      parts.push("\n");
    }
  }
  return { text: parts.join(""), frames: total, lostFrames };
}

/** fork 剪切：只留最后一个 inherited 标记之后的事件。marker 缺 seq（畸形）视为无标记不剪——
 * 全剪空会让该会话静默 0 记录，宁多计已知事件也不静默丢。 */
export function cutInheritedEvents(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "session/end-seed" && event?.data?.inherited === true) {
      const cut = Number(event.seq);
      if (!Number.isFinite(cut)) return events;
      return events.filter((item) => Number(item?.seq) > cut);
    }
  }
  return events;
}

function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;
  const log = makeLogger(ctx);
  const store = createStore({ storageRoot: cfg.storageRoot, log });

  // 单写者锁（SPEC §3）：装载即抢占。抢不到（另一宿主实例新鲜持锁）= 本实例显式降级为
  // 只读镜像——不订阅不落盘不回填，API 照常供读；可见降级记 warn，不是静默 fail-open。
  // 镜像不是终态：挂慢速重试（5min 锁自愈只对"之后才启动的实例"成立，
  // 本进程若不重试，镜像期增量会永久丢）；接管成功即翻转 writer 并补一次回填。
  let writer = true;
  let lockRetryTimer = null;
  let lockHeartbeatTimer = null;
  try {
    store.acquireLock();
  } catch (error) {
    // 装载抢锁失败与「心跳发现易主」走同一条降级/重试/接管路径（单一实现）
    demoteToMirror(error);
  }

  // 会话级内存态：live fold 状态 / 回填终态（live 续接用，取走即删）/ 最近模型路由
  const foldStates = new Map();
  const inheritedStates = new Map();
  const lastRoute = new Map();

  // 记账水位：records 是唯一真源，水位从 records 推导（watermarkOf）。
  // marker（v4）只存「无法从 records 推导的东西」：done（v1 兼容）、watermarks（语义收窄为
  // 仅 bootstrap 基线——mtime 哨兵/空会话分支写的起点 seq）、mtimes（mtime 哨兵）。
  // live 完全不写 marker：SIGKILL 崩溃窗丢的只是内存态，重启后从 records 推导水位，而 records
  // 每条 appendFileSync 同步落盘——推导水位已含崩溃前全部已落盘 record，无丢失窗。
  // marker 内存态装载即从盘初始化：回填外的任何写点都不存在，盘上 marker
  // 只会被回填/bootstrap 路径以合并后的完整快照覆写，「清空窗」随之自然消失。
  const bootMarker = store.readBackfillMarker();
  let markerWatermarks = bootMarker?.watermarks && typeof bootMarker.watermarks === "object" ? { ...bootMarker.watermarks } : {};
  let markerDone = Array.isArray(bootMarker?.done) ? [...bootMarker.done] : [];
  let markerMtimes = bootMarker?.mtimes && typeof bootMarker.mtimes === "object" ? { ...bootMarker.mtimes } : {};
  let markerDirty = false; // marker 内存态有未落盘变更（bootstrap/回填置位，writeMarkerNow 清）

  // 日聚合内存缓存：{obj, seenTurns:Set<"sid:turn">, dirty}
  const dailyCache = new Map();
  let flushTimer = null;

  // records 按日索引：Map<date, records[]>，recordsOfDate 从 O(全量过滤) 降为 O(1)；
  // 重建时顺带按 sid 聚合 max(seq) 得推导水位。装载/失效后首个读取点全量重建，
  // append 成功后增量维护对应日期桶（indexRecord）。只读镜像不建索引：
  // 无 append 置脏事件，缓存会把 trend 冻结在首查快照。
  let recordsIndex = null; // Map<"YYYY-MM-DD", record[]>
  let derivedWatermarks = null; // Map<sessionId, 已记账最大事件 seq>
  const invalidateRecords = () => {
    recordsIndex = null;
    derivedWatermarks = null;
  };

  /** 从 records 按 sessionId 聚合 max(seq) → 派生记账水位（写入 derivedWatermarks）。
   *  推导水位随 records 增长自动前进——live append 与回填 append 都进 records，无需手动推进；
   *  append 失败的 record 不进 records → 推导水位不含它 → 下轮回填补齐（由架构保证）。 */
  function deriveWatermarksFromRecords(records) {
    for (const record of records) {
      const seq = Number(record?.seq);
      const sid = record?.sessionId;
      if (sid === void 0 || !Number.isFinite(seq)) continue;
      const prev = derivedWatermarks.get(sid);
      if (prev === void 0 || seq > prev) derivedWatermarks.set(sid, seq);
    }
  }

  /** 按日索引全量重建（读 records 便宜，只在装载/失效后首个读取点发生一次）。 */
  function ensureRecordsIndex() {
    if (recordsIndex !== null) return;
    const index = new Map();
    for (const record of store.readAllRecords()) {
      // 与 rebuildAllDaily 同一过滤：只认正数时间戳（Number(null)/Number("")===0 会伪造 1970 桶；
      // 非法时间戳的 record 对任何合法查询日都不可见，与旧全量过滤语义一致）
      if (record === null || typeof record !== "object" || !(Number(record?.time) > 0)) continue;
      const date = isoOf(record.time);
      let bucket = index.get(date);
      if (bucket === void 0) index.set(date, (bucket = []));
      bucket.push(record);
    }
    recordsIndex = index;
    derivedWatermarks = new Map();
    for (const bucket of index.values()) deriveWatermarksFromRecords(bucket);
  }

  /** append 成功后的增量维护：record 进对应日期桶 + 推导水位前进。失败的 record 两个都不进——
   *  「落盘成功才算已记账」的纪律由缓存结构天然表达。索引未建时无事可做（磁盘已有该条，
   *  下次 ensureRecordsIndex 全量重建自然包含）。 */
  function indexRecord(record) {
    if (recordsIndex === null) return;
    const date = isoOf(record.time);
    let bucket = recordsIndex.get(date);
    if (bucket === void 0) recordsIndex.set(date, (bucket = []));
    bucket.push(record);
    deriveWatermarksFromRecords([record]);
  }

  // 写锁心跳：mtime 陈旧判定（≥5min）只有配合「持有期续期」才等价于持有者死亡。
  // 归属校验联动：锁被接管（睡眠唤醒竞速/事件循环停摆≥5min）时 touchLock 抛
  // LOCK_LOST——立即停采集降级镜像并挂重试，不做幽灵写者（以陈旧快照覆写 marker=抹掉对方账本）
  function demoteToMirror(reason) {
    writer = false;
    log.warn("写锁已易主，本实例降级为只读镜像（60s 周期重试接管）", reason);
    if (lockHeartbeatTimer !== null) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
    if (lockRetryTimer !== null) return;
    lockRetryTimer = setInterval(() => {
      try {
        store.acquireLock();
      } catch {
        return;
      }
      clearInterval(lockRetryTimer);
      lockRetryTimer = null;
      writer = true;
      log.info("写锁已接管，采集与回填恢复");
      lockHeartbeatTimer = setInterval(() => {
        try {
          store.touchLock();
        } catch {
          demoteToMirror(new Error("心跳发现锁再次易主"));
        }
      }, LOCK_HEARTBEAT_MS);
      lockHeartbeatTimer.unref?.();
      setImmediate(() => {
        (async () => {
          if (backfillRunning) return;
          backfillRunning = true;
          try {
            const result = await runBackfill();
            log.info(`接管后补跑回填：会话 ${result.backfilled}，记录 ${result.records} 条`);
          } catch (error) {
            backfillProgress.error = sanitizeErrorText(error);
            log.error("接管后补跑回填失败", error);
          } finally {
            backfillRunning = false;
            endBackfillProgress();
          }
        })();
      });
    }, LOCK_RETRY_MS);
    lockRetryTimer.unref?.();
  }

  if (writer) {
    lockHeartbeatTimer = setInterval(() => {
      try {
        store.touchLock();
      } catch (error) {
        if (error?.code === "LOCK_LOST") {
          demoteToMirror(error);
        }
        /* 其他心跳失败（瞬时 IO 错误）不打断采集，下个周期重试 */
      }
    }, LOCK_HEARTBEAT_MS);
    lockHeartbeatTimer.unref?.();
  }

  ctx.effect(() => async () => {
    if (lockHeartbeatTimer !== null) clearInterval(lockHeartbeatTimer);
    if (lockRetryTimer !== null) clearInterval(lockRetryTimer);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushDirtyDaily();
    if (markerDirty) writeMarkerNow(); // 兜底：常规路径 bootstrap/回填已即时落盘，live 不再有 marker 写点
    store.close();
  }, "dsh-usage-stats lifecycle");

  ctx.on("session/disposed", (session) => {
    try {
      const sid = session?.id;
      foldStates.delete(sid);
      inheritedStates.delete(sid);
      lastRoute.delete(sid);
    } catch {
      /* ignore */
    }
  });

  // 只读镜像仍注册 API 路由（SPEC承诺：降级不误伤读取面）；采集/回填两段在下方守卫
  ctx.on("session/event", (session, event) => {
    if (!writer) return; // 镜像不采集
    try {
      seeEvent(session?.id, event);
    } catch (error) {
      // 订阅回调永不炸宿主轮次；显式记日志不静默吞
      log.error("session/event 处理异常", error);
    }
  });

  function seeEvent(sid, event) {
    if (sid === void 0 || event === void 0 || event === null) return;
    if (event.type === "request/header") {
      // 会话级最近路由：assistant/attempt 无 source，attempt 的模型归属走这里
      const header = event.data?.header?.config;
      if (header && typeof header === "object" && typeof header.provider === "string" && typeof header.model === "string") {
        lastRoute.set(sid, { provider: header.provider, model: header.model });
      }
      return;
    }
    if (!FOLD_EVENT_TYPES.has(event.type)) return;

    let state = foldStates.get(sid);
    if (state === void 0) {
      const inherited = inheritedStates.get(sid);
      inheritedStates.delete(sid);
      state = inherited ?? createFoldState();
    }
    const result = applyEvent(state, event);
    foldStates.set(sid, state);
    if (result.delta === void 0) return;

    // live 样本 seq ≤ 记账水位（records 推导 ∪ bootstrap 基线）
    // = 已被记账（live 晚于回填启动的重复投递）——跳过不重复记账。
    // 同值重放本来也是 no-op；异值属替换窗跨进程的已知局限，跳过比双计保守
    const persistedWm = watermarkOf(sid);
    if (persistedWm !== null && Number.isFinite(Number(event.seq)) && Number(event.seq) <= persistedWm) return;

    const time = typeof event.time === "number" ? event.time : Date.now();
    const route = routeOf(sid, event);
    const ok = appendRecord({
      time,
      seq: event.seq,
      sessionId: sid,
      provider: route.provider,
      model: route.model,
      turn: event.data?.turn,
      step: event.data?.step,
      kind: result.kind,
      usage: result.delta,
    });
    if (!ok) return;
    // 到这里 record 已 appendFileSync 同步落盘、并增量进 records 索引——记账水位无需任何手动
    // 推进或落盘：watermarkOf 下次读取从 records 推导，天然含本条。
    // live 因此不再有水位内存态、不写 marker：SIGKILL 后重启从 records 推导，已落盘的
    // record 不丢账、未落盘的 record 本就不存在，无丢失窗。
  }

  function routeOf(sid, event) {
    const source = event.data?.message?.source;
    if (source && typeof source.provider === "string" && typeof source.model === "string") {
      lastRoute.set(sid, { provider: source.provider, model: source.model });
      return lastRoute.get(sid);
    }
    return lastRoute.get(sid) ?? { provider: "unknown", model: "unknown" };
  }

  function appendRecord(record) {
    const ok = store.append(record);
    if (!ok) return false; // 落盘失败不进日聚合/索引：daily 不能出现 records 里不存在的幻影用量
    indexRecord(record); // 增量维护按日索引与推导水位（失败的条目两边都不进）
    const date = isoOf(record.time);
    const entry = dailyEntry(date);
    updateDailyWithRecord(entry, record);
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        try {
          flushDirtyDaily();
        } catch (error) {
          log.warn("日聚合缓存写盘失败", error);
        }
      }, DAILY_FLUSH_MS);
    }
    return ok;
  }

  function dailyEntry(date) {
    let entry = dailyCache.get(date);
    if (entry === void 0) {
      const stored = store.readDaily(date);
      entry = { obj: stored ?? emptyDaily(date), seenTurns: new Set(), dirty: false };
      dailyCache.set(date, entry);
    }
    return entry;
  }

  /** 从当日 records 反推 (sid,turn) 首见集合——与增量路径的 seenTurns 同语义（kind==="add" 才计轮）。 */
  function collectSeenTurns(records) {
    const seen = new Set();
    for (const record of records) {
      if (record?.kind !== "add") continue;
      seen.add(`${record.sessionId}:${record.turn}`);
    }
    return seen;
  }

  function updateDailyWithRecord(entry, record) {
    const { obj } = entry;
    const key = `${record.provider}/${record.model}`;
    let bucket = obj.byModel[key];
    if (bucket === void 0) {
      bucket = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 0, turns: 0 };
      obj.byModel[key] = bucket;
    }
    const sum = BUCKET_KEYS.reduce((acc, k) => acc + record.usage[k], 0);
    for (const k of BUCKET_KEYS) bucket[k] += record.usage[k];
    bucket.samples += 1;
    const hour = new Date(record.time).getHours();
    obj.byHour[hour] += sum;
    const sessionEntry = obj.sessions[record.sessionId];
    if (sessionEntry === void 0) obj.sessions[record.sessionId] = { firstMs: record.time, lastMs: record.time };
    else {
      if (record.time < sessionEntry.firstMs) sessionEntry.firstMs = record.time;
      if (record.time > sessionEntry.lastMs) sessionEntry.lastMs = record.time;
    }
    // turns 口径（SPEC §4）：kind==="add" 的 (sid,turn) 首见才 +1；全零 add 也计（聚合层统一口径）
    const turnKey = `${record.sessionId}:${record.turn}`;
    if (record.kind === "add" && !entry.seenTurns.has(turnKey)) {
      entry.seenTurns.add(turnKey);
      bucket.turns += 1;
    }
    entry.dirty = true;
  }

  function flushDirtyDaily() {
    for (const [date, entry] of dailyCache) {
      if (!entry.dirty) continue;
      store.writeDaily(date, entry.obj);
      entry.dirty = false;
    }
  }

  /** 会话当前记账水位 = max(records 推导水位, bootstrap 基线)。
   *  推导水位天然包含 live 与回填两侧全部已落盘 record；bootstrap 基线只来自 marker（v3 旧
   *  记账水位读入时也并入基线，取大向后兼容）。两者皆无返回 null。 */
  function watermarkOf(sid) {
    ensureRecordsIndex();
    const candidates = [];
    const derived = derivedWatermarks.get(sid);
    if (derived !== void 0) candidates.push(derived);
    const bootstrap = Number(markerWatermarks[sid]);
    if (Number.isFinite(bootstrap)) candidates.push(bootstrap);
    return candidates.length > 0 ? Math.max(...candidates) : null;
  }

  /** marker 落盘（v4）：只含 done + bootstrap 基线水位 + mtimes。触发点仅剩
   *  回填/bootstrap/.effect 兜底——live 不再写 marker，装载即初始化内存态后「marker
   *  清空窗」自然消失：盘上 marker 只被回填路径以完整快照覆写，不存在被空快照抹掉的窗。 */
  function writeMarkerNow() {
    store.writeBackfillMarker({ done: markerDone, watermarks: markerWatermarks, mtimes: markerMtimes, updatedAt: Date.now() });
    markerDirty = false;
  }

  /** API 读前先落盘脏日档，保证读到的不落后于内存。 */
  function consistentDailies() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushDirtyDaily();
    const dates = store.listDailyDates();
    const dailies = [];
    for (const date of dates) {
      const cached = dailyCache.get(date);
      dailies.push(cached !== void 0 ? cached.obj : store.readDaily(date));
    }
    return dailies.filter((item) => item !== void 0 && item !== null);
  }

  /** 某日 records：按日索引 O(1) 直取，与旧「全量过滤」语义一致
   *  （索引构建时已滤非法时间戳，它们对任何合法查询日都不可见）。 */
  function recordsOfDate(date) {
    if (!writer) return store.readAllRecords().filter((record) => isoOf(record?.time) === date);
    ensureRecordsIndex();
    return recordsIndex.get(date) ?? [];
  }

  /** 全量 records（兼容语义，保留给需要全量数组的调用方；按日捞取已走 recordsOfDate 索引）。
   *  镜像模式绕过索引直读（镜像无置脏事件，缓存会把 trend 冻结在首查快照）。 */
  function allRecords() {
    if (!writer) return store.readAllRecords();
    ensureRecordsIndex();
    const all = [];
    for (const bucket of recordsIndex.values()) {
      for (const record of bucket) all.push(record);
    }
    return all;
  }

  // ---- 路由 ----

  function parseQuery(req) {
    return new URL(req.url ?? "/", "http://loopback").searchParams;
  }

  function intParam(params, key, fallback, allowed) {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || (allowed !== void 0 && !allowed.includes(value))) return fallback;
    return value;
  }

  function makeRoutes() {
    const get = (path, handler) => ({
      kind: "exact",
      path,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "loopback requests only" });
        if (req.method !== "GET" && req.method !== "HEAD") return writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
        try {
          writeJson(res, 200, handler(parseQuery(req)));
        } catch (error) {
          log.error(`路由处理失败 ${path}`, error);
          writeJson(res, 500, { error: "internal error" });
        }
      },
    });
    return [
      get(`${API_BASE}/summary`, () => summarize(consistentDailies(), isoOf(Date.now()))),
      get(`${API_BASE}/heatmap`, (params) => {
        const days = intParam(params, "days", 366); // 0=全量；任意非负整数合法（client 恒传 366）
        const since = days > 0 ? addDaysIso(isoOf(Date.now()), -(days - 1)) : void 0;
        return heatmapDays(consistentDailies(), since);
      }),
      get(`${API_BASE}/trend`, (params) => {
        const days = intParam(params, "days", 7, [1, 7, 30]);
        const today = isoOf(Date.now());
        const dayRecords = days === 1 ? recordsOfDate(today) : void 0;
        return trendPoints(consistentDailies(), days, dayRecords, today);
      }),
      get(`${API_BASE}/models`, (params) => {
        const days = intParam(params, "days", 7, [7, 30]);
        return modelShares(consistentDailies(), days, isoOf(Date.now()));
      }),
      // 回填进度路由：GET exact + loopback 守卫同款（get() 内建，POST 打它 405）。
      // 响应形状见 backfillProgress 声明处注释；镜像实例没有回填路径，恒返回 running:false。
      get(`${API_BASE}/backfill/status`, () => ({ ...backfillProgress })),
      {
        kind: "exact",
        path: `${API_BASE}/backfill`,
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "loopback requests only" });
          if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
          if (!writer) return writeJson(res, 503, { error: "read-only mirror (another instance holds the write lock)" });
          if (backfillRunning) return writeJson(res, 409, { error: "backfill already running" });
          backfillRunning = true;
          // 受理即置进度 running（早于下一拍才真正启动的 runBackfill）：client 首查 status
          // 不会撞进「还没开始=running:false」窗而误判成已完成
          startBackfillProgress();
          // 立即 202 受理，任务下一拍后台跑，进度经 GET /backfill/status
          // 轮询读取。旧「挂起到跑完再回 200/错误体」语义废弃——大历史下按钮无进度像卡死。
          writeJson(res, 202, { ok: true, started: true });
          setImmediate(() => {
            (async () => {
              try {
                await runBackfill();
              } catch (error) {
                // 失败信号必须进 status：否则 client 把崩溃窗报成「回填完成」，
                // 面板却因 daily 缺档显示暂无数据——自相矛盾的成功。records 已落盘，下次成功跑自愈
                backfillProgress.error = sanitizeErrorText(error);
                log.error("手动回填失败", error);
              } finally {
                backfillRunning = false;
                endBackfillProgress();
              }
            })();
          });
        },
      },
    ];
  }

  let backfillRunning = false;

  // 回填进度对象：路由层（GET /backfill/status）与 runBackfill 分片循环共享，
  // runBackfill 逐会话写计数（分片让出窗内 client 轮询读到的是实时值），只加观察、不动记账语义。
  // 作用域在 apply() 闭包内而非模块级：同进程可并存写者+镜像多实例（集成测试即如此），
  // 进度必须每实例独立——镜像实例恒 running:false，真模块级对象会跨实例串台。
  // 响应形状（GET /api/dsh-usage-stats/backfill/status 的 body，逐字段SPEC）：
  //   { running: boolean,          // 本轮回填是否进行中（auto/接管/手动三路共用一对象）
  //     startedAt: number|null,    // 最近一轮开始时刻（epoch ms；本实例从未跑过回填为 null）
  //     scanned: number,           // 最近一轮已扫过会话数（逐会话推进，0..total）
  //     total: number,             // 最近一轮会话清单总数（client「已扫 X/Y 会话」的分母）
  //     backfilled: number,        // 最近一轮已完成回填的会话数
  //     records: number,           // 最近一轮已落盘 record 数
  //     lostFrames: number,        // 最近一轮解压失败被跳过的帧数
  //     finishedAt: number|null }  // 最近一轮结束时刻（epoch ms；进行中/从未跑过为 null）
  const backfillProgress = {
    running: false, startedAt: null, scanned: 0, total: 0,
    backfilled: 0, records: 0, lostFrames: 0, finishedAt: null, error: null,
  };
  function startBackfillProgress() {
    backfillProgress.running = true;
    backfillProgress.startedAt = Date.now();
    backfillProgress.scanned = 0;
    backfillProgress.total = 0;
    backfillProgress.backfilled = 0;
    backfillProgress.records = 0;
    backfillProgress.lostFrames = 0;
    backfillProgress.finishedAt = null;
    backfillProgress.error = null;
  }
  // 结束只翻状态不请零计数：client 在 running=false 后读 backfilled/records 展示成果
  function endBackfillProgress() {
    backfillProgress.running = false;
    backfillProgress.finishedAt = Date.now();
  }

  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const disposers = makeRoutes().map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-usage-stats: api routes");
  });

  // ---- 历史回填（T7） ----

  /** 扫 sessionsRoot 两层：<workspace编码目录>/<sessionId>/session.vN.jsonl.zstd */
  function listSessionFiles() {
    if (!existsSync(cfg.sessionsRoot)) return [];
    const found = [];
    for (const ws of readdirSafe(cfg.sessionsRoot)) {
      const wsDir = join(cfg.sessionsRoot, ws);
      if (!isDir(wsDir)) continue;
      for (const sid of readdirSafe(wsDir)) {
        const sidDir = join(wsDir, sid);
        if (!isDir(sidDir)) continue;
        for (const file of readdirSafe(sidDir)) {
          if (!SESSION_FILE_RE.test(file)) continue;
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(join(sidDir, file)).mtimeMs;
          } catch {
            /* 文件刚被删：保留 0，回填循环按 mtime 哨兵逻辑处理 */
          }
          found.push({ sid, path: join(sidDir, file), version: Number(SESSION_FILE_RE.exec(file)[1]), mtimeMs });
        }
      }
    }
    return found;
  }

  function readdirSafe(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  function isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

  /** 按 records（唯一真源）按需重建全部日期的日聚合，并同步内存缓存。
   *  每次回填（装载 auto 与手动 POST 都走这里）末尾执行。触发条件：
   *  ①本轮回填补了记录（produced>0），或 ②daily 文件日期集 ≠ records 覆盖日期集
   *  （崩溃窗丢档/手工删档 → 自愈）。稳态（零新增且日期集一致）零写盘——
   *  读 records 刷缓存与推导水位便宜（无条件做），写文件才是大头（有条件才做）。 */
  function rebuildAllDaily(producedThisRun) {
    invalidateRecords();
    flushDirtyDaily();
    ensureRecordsIndex(); // 刷新按日索引 + 推导水位（无条件；读 records 不写盘）
    const recordDates = new Set(recordsIndex.keys());
    const dailyDates = new Set(store.listDailyDates());
    let datesDiffer = recordDates.size !== dailyDates.size;
    if (!datesDiffer) {
      for (const date of recordDates) {
        if (!dailyDates.has(date)) {
          datesDiffer = true;
          break;
        }
      }
    }
    if (producedThisRun > 0 || datesDiffer) {
      // 崩溃自愈语义保留：崩溃窗 daily 缺档 → 日期集不一致 → 重建触发
      for (const [date, records] of recordsIndex) {
        store.writeDaily(date, rebuildDaily(records, date));
        const cached = dailyCache.get(date);
        if (cached !== void 0) {
          cached.obj = store.readDaily(date);
          // seenTurns 从重建源反推：清零会让「同日同轮 retry 后样本」重复计轮
          cached.seenTurns = collectSeenTurns(records);
          cached.dirty = false;
        }
      }
      // 幻影档清理：重建只写 records 覆盖日期，盘上多出的 daily 档不删的话
      // 日期集永不一致 → 条件重建每轮触发 + 幻影档以 0-token 空格进热力图
      for (const date of dailyDates) {
        if (!recordDates.has(date)) {
          store.removeDaily(date);
          dailyCache.delete(date);
        }
      }
    }
    return recordDates.size;
  }

  /** 回填。async+分片：每个会话处理后让出一拍（同步单段会冻结整个宿主，
   *  且冻结时长随历史线性增长）。让出窗的 live 交错由「每会话处理前动态查 foldStates」挡住：
   *  live 采过的会话进 foldStates，轮到它时被跳过（其数据由水位法在后续回填补齐）。 */
  async function runBackfill() {
    const started = Date.now();
    startBackfillProgress(); // 进度复位（POST 路径受理时已置 running；此处覆盖 auto/接管两路并清零计数）
    // 刷新盘上状态到内存：done 取并集、watermarks/mtimes 逐键取大（装载即初始化的连带——
    // 内存态装载即初始化后，这里只做合并，绝不整体覆盖，防抹掉装载后本进程写入的条目）。
    // watermarks 合并语义：v4 里只有 bootstrap 基线；读 v3 旧文件时其记账
    // 水位整包并入基线（取大）向后兼容——基线只抬高起算点，与推导水位取 max 后语义不变
    const marker = store.readBackfillMarker();
    if (marker !== null && typeof marker === "object") {
      const diskDone = new Set(Array.isArray(marker.done) ? marker.done : []);
      const memDone = new Set(markerDone);
      markerDone = [...new Set([...memDone, ...diskDone])];
      const diskWm = marker.watermarks && typeof marker.watermarks === "object" ? marker.watermarks : {};
      for (const [sid, seq] of Object.entries(diskWm)) {
        const n = Number(seq);
        if (!Number.isFinite(n)) continue;
        if (!Number.isFinite(markerWatermarks[sid]) || n > markerWatermarks[sid]) markerWatermarks[sid] = n;
      }
      const diskMt = marker.mtimes && typeof marker.mtimes === "object" ? marker.mtimes : {};
      for (const [sid, m] of Object.entries(diskMt)) {
        const n = Number(m);
        if (!Number.isFinite(n)) continue;
        if (!Number.isFinite(markerMtimes[sid]) || n > markerMtimes[sid]) markerMtimes[sid] = n;
      }
    }
    const done = new Set(markerDone);
    const files = listSessionFiles();
    backfillProgress.total = files.length;

    let backfilled = 0;
    let skippedActive = 0;
    let skippedVersion = 0;
    let skippedBootstrap = 0;
    let lostFrames = 0;
    let produced = 0;
    let markerChanged = false;
    let processed = 0;

    for (const item of files) {
      // yield 放在循环体最前：守卫与 startSeq 的取样必须在让出之后，
      // 与 unpack/fold/append（处理段，无 await=原子）同窗——否则「让出前取样、让出后记账」
      // 的 TOCTOU 窗会吃进让出期到达的 live 事件造成双计
      processed += 1;
      backfillProgress.scanned = processed; // 进度观察：逐会话推进
      if (processed % 4 === 0) await yieldTick();
      // 水位优先（水位法终版语义）：有水位=已被记账过，只补增量（不看 done——
      // done 里的会话被 live 续采后仍有尾部增量要补）；无水位且在 done=v1 时代已全量折，走 mtime 哨兵；
      // 双无=全新会话，全量折。
      const startSeq = watermarkOf(item.sid);
      // 动态守卫先于 bootstrap：live 见过 request/header 的会话在 foldStates，
      // 若它同时是 done-only（无水位），bootstrap 会把水位推到文件尾且不给 live 终态——后续同键样本无基线
      if (foldStates.has(item.sid)) {
        skippedActive += 1;
        continue;
      }
      if (startSeq === null && done.has(item.sid)) {
        // v1 done 且无水位：曾全量记账但基线 seq 未知——不能重折（双计）也不能补（漏计固化）。
        // mtime 哨兵：文件未变（常态）直接跳过零成本；变了说明停用/离线窗有增长——
        // 此时 live 必然没采过（有推导水位的会话 startSeq≠null 走不到这分支），全量重折安全。
        // bootstrap：只求 maxSeq 写「bootstrap 基线」水位（不 append，宁漏不双计），
        // 此后增量经推导水位正常补齐。
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(item.path).mtimeMs;
        } catch {
          continue;
        }
        if (Number.isFinite(Number(markerMtimes[item.sid])) && Number(markerMtimes[item.sid]) === mtimeMs) continue;
        try {
          const buf = readFileSync(item.path);
          const { text } = decompressSessionFile(buf);
          let maxSeq = 0;
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let event;
            try {
              event = JSON.parse(trimmed);
            } catch {
              continue;
            }
            const seq = Number(event?.seq);
            if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
          }
          markerWatermarks[item.sid] = maxSeq;
          markerMtimes[item.sid] = mtimeMs;
          markerChanged = true;
          markerDirty = true;
          writeMarkerNow();
          skippedBootstrap += 1;
        } catch (error) {
          log.warn(`回填 bootstrap 会话 ${item.sid} 失败，跳过`, error);
        }
        continue;
      }
      // mtime 哨兵：文件未变 ⇒ 无新事件 ⇒ 增量折必为零条，
      // 直接跳过解压——稳态装载不再为历史会话付任何解压成本
      if (Number.isFinite(Number(markerMtimes[item.sid])) && Number(markerMtimes[item.sid]) === item.mtimeMs) continue;
      if (item.version !== KNOWN_SESSION_VERSION) {
        skippedVersion += 1;
        log.warn(`回填跳过不支持的会话文件版本 v${item.version}（${item.sid}）`);
        continue;
      }
      try {
        const buf = readFileSync(item.path);
        const { text, lostFrames: lost } = decompressSessionFile(buf);
        lostFrames += lost;
        backfillProgress.lostFrames = lostFrames;
        const events = [];
        let versionHeaderSeen = false;
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue; // 单坏行跳过（帧失败留下的残行）
          }
          if (!versionHeaderSeen && event?.type === "session") {
            versionHeaderSeen = true;
            if (event.version !== KNOWN_SESSION_VERSION) throw new Error(`会话头版本 v${event.version} 不受支持`);
          }
          events.push(event);
        }
        const live = cutInheritedEvents(events);
        if (live.length === 0) {
          // 空会话/0 字节文件：无事件可折，记 done+基线水位0+mtime——
          // 水位 0 是 bootstrap 基线（起点=文件开头）：日后文件增长时 startSeq=0 走增量路径
          // 全量补齐；只标 done 不建基线的话，增长会落进 bootstrap 分支被吞成新基线（永久漏账）
          if (!done.has(item.sid) || !Number.isFinite(Number(markerWatermarks[item.sid]))) {
            done.add(item.sid);
            markerDone = [...done];
            if (!Number.isFinite(Number(markerWatermarks[item.sid]))) markerWatermarks[item.sid] = 0;
            markerMtimes[item.sid] = item.mtimeMs;
            markerChanged = true;
            markerDirty = true;
            writeMarkerNow();
          }
          continue;
        }
        const state = createFoldState();
        const sessionRoute = { provider: "unknown", model: "unknown" }; // attempt 无 source，走会话最近路由（与 live 同语义）
        let producedHere = 0; // 本会话 append 成功的 record 数（append 零成功时不写 marker，防 mtime 哨兵固化故障窗）
        for (const event of live) {
          const seq = Number(event?.seq);
          if (event?.type === "request/header") {
            const header = event.data?.header?.config;
            if (header && typeof header === "object" && typeof header.provider === "string" && typeof header.model === "string") {
              sessionRoute.provider = header.provider;
              sessionRoute.model = header.model;
            }
            continue;
          }
          if (!FOLD_EVENT_TYPES.has(event?.type)) continue;
          // fold 必须吃全文件（含水位前样本）——水位后首个样本若与水位前构成同键替换，
          // 槽基线来自水位前样本才能产出正确的 replace 差值（过滤只能在
          // applyEvent 之后只跳落盘，不能跳 fold）。
          const result = applyEvent(state, event);
          if (result.delta === void 0) continue;
          if (startSeq !== null && Number.isFinite(seq) && seq <= startSeq) continue;
          const time = typeof event.time === "number" ? event.time : void 0;
          if (time === void 0) continue; // 无时间戳无法归日，宁缺勿造（fail-visible：计 lostFrames 之外再无静默路径）
          const source = event.data?.message?.source;
          const record = {
            time,
            seq: event?.seq,
            sessionId: item.sid,
            provider: typeof source?.provider === "string" ? source.provider : sessionRoute.provider,
            model: typeof source?.model === "string" ? source.model : sessionRoute.model,
            turn: event.data?.turn,
            step: event.data?.step,
            kind: result.kind,
            usage: result.delta,
          };
          // append 失败的 record 不进 records（缓存两边都不进）→ 推导水位不含它 → 下轮回填
          // 自动补齐。「append 失败不推水位」由架构天然保证，
          // 原 maxSeqSinceAppend 机制已删除。
          if (store.append(record)) {
            producedHere += 1;
            produced += 1;
            backfillProgress.records = produced; // 进度观察：逐条推进
            indexRecord(record); // 回填直写不经 appendRecord：增量进索引，回填中途 GET /trend 读到的也是新账
          }
        }
        // 终态交给 live：回填后该会话若继续产生事件，从继承后的正确槽状态续算
        // 回填终态交给 live 续算（水位法必要环节——不给的话 live 从零状态重折同键样本双计）。
        // 仅对「有 live 痕迹」的会话交接（lastRoute/foldStates 有它=本进程见过其事件），
        // 纯历史会话不写防 inheritedStates 随回填历史无界滞留
        if (foldStates.has(item.sid) || lastRoute.has(item.sid)) inheritedStates.set(item.sid, state);
        done.add(item.sid);
        // marker v4 记账：只写 done+mtime（mtime 哨兵稳态零解压），水位不再写——
        // 本会话全部成功落盘的 record 已在 records 里，watermarkOf 下轮从 records 推导。
        // append 零成功时不写（含 done）：否则 mtime 哨兵把故障窗固化，恢复后永不补
        if (producedHere > 0) {
          markerDone = [...done];
          markerMtimes[item.sid] = item.mtimeMs;
          markerChanged = true;
          markerDirty = true;
          // marker 增量落盘：进程被强杀时已完成会话不重跑——
          // 否则中断后的手动重跑会把已 append 的会话全部再折一遍，永久双计
          writeMarkerNow();
        }
        backfilled += 1;
        backfillProgress.backfilled = backfilled;
      } catch (error) {
        log.warn(`回填会话 ${item.sid} 失败，跳过`, error);
      }
    }

    // 日聚合真源自愈（条件化）：按需按 records 重建全部日期的 daily，
    // 崩溃窗丢的防抖日档在启动/手动回填时自动补齐；稳态零新增且日期集一致时零写盘
    rebuildAllDaily(produced);
    if (markerChanged) writeMarkerNow(); // 有变更才写（零变更不刷盘）
    const result = { scanned: files.length, backfilled, skippedActive, skippedVersion, skippedBootstrap, records: produced, lostFrames, ms: Date.now() - started };
    if (backfilled > 0 || produced > 0) log.info(`历史回填完成：会话 ${backfilled}/${files.length}，记录 ${produced} 条，${result.ms}ms`);
    else log.info("历史回填：无新增会话需要回填");
    if (lostFrames > 0) log.warn(`回填解压跳过损坏帧 ${lostFrames} 个（对应事件缺失，详见会话文件）`);
    return result;
  }

  // 装载即跑一次自动回填（仅写者实例，幂等增量：marker.done 已含的会话秒级跳过）。
  // 判据不挂 hasAnyRecords——中断恢复后 records 已存在但 done 不全，靠幂等补齐而不是不跑。
  if (writer) {
    setImmediate(() => {
      (async () => {
        // 与手动/接管路径共用 409 闩：async 分片化后 auto 让出窗可被 POST 插入，
        // 双回填并发虽被水位幂等兜住，但语义上该拒绝且白付一遍全量解压
        if (backfillRunning) return;
        backfillRunning = true;
        try {
          await runBackfill();
        } catch (error) {
          backfillProgress.error = sanitizeErrorText(error);
          log.error("自动回填失败", error);
        } finally {
          backfillRunning = false;
          endBackfillProgress();
        }
      })();
    });
  }
}

export { apply, inject, name };
