// dsh-usage-stats — token 用量折叠状态机（SPEC §2，照抄 @deepseek-ai/dsh-token-meter
// 的 tokenUsage 投影语义，勿"优化"）。
// 语义要点：官方 totals = 「替换槽 LWW + retry-started 结转清槽后同键累加」。本状态机对每条
// 事件即时产出净增量，增量流逐条求和 == 官方 totals——这是聚合对账（SPEC §7）的成立基础。
// 已知局限（不做持久化）：替换槽 live 在内存，进程重启即弃——替换窗横跨
// 重启时旧样本被双计，极罕见。

// 四桶键序与SPEC §3 record.usage 示例一致
const BUCKET_KEYS = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

const ZERO_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** 新建折叠状态。按 sessionId 各一份（分账由宿主负责）。 */
export function createFoldState() {
  return {
    totals: { ...ZERO_BUCKETS },
    last: null, // 替换槽 {turn, step, buckets}；null = 无待替换样本
  };
}

/**
 * usage 原始形状 → 四桶。uncachedInputTokens 直接取 inputTokens（官方桶名如此，不减缓存）；
 * cache 两项官方口径为 0 时字段缺省，?? 0 补齐；totalTokens 不落桶（四桶可推导，官方投影也不含）。
 * 非对象入参返回 undefined（调用方按"无变化"处理）。
 */
export function bucketsFromUsage(usage) {
  if (usage === void 0 || usage === null || typeof usage !== "object") return void 0;
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
}

/** assistant/attempt 采样：stream 从后往前第一条 usage 块的 usage；没有则 undefined。 */
export function lastAttemptUsage(data) {
  const stream = data?.stream;
  if (!Array.isArray(stream)) return void 0;
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i];
    if (record?.type === "chunk" && record.chunk?.type === "usage") return record.chunk.usage;
  }
  return void 0;
}

/**
 * 就地更新 state 并返回增量结果（SPEC允许就地更新；性能与简单优先）。
 * 返回 {changed, delta?, kind?}：
 *   - changed=true 仅代表状态被改动（含 retry 清槽）；宿主落盘判据是 delta !== undefined
 *     （清槽不产生增量、不落 record，否则聚合求和就不等于官方 totals）。
 *   - kind: "add" 新键样本 / "replace" 同键替换差值（四项可为负，聚合求和自然抵消）。
 */
export function applyEvent(state, event) {
  if (state === void 0 || state === null || typeof state !== "object") {
    throw new Error("dsh-usage-stats: applyEvent 的 state 必须由 createFoldState 创建");
  }
  const type = event?.type;
  const data = event?.data;

  if (type === "llm/retry-started") {
    // 清槽仅当槽键与 retry 的 (turn,step) 一致：此后同键样本改走累加（结转语义）
    if (state.last !== null && state.last.turn === data?.turn && state.last.step === data?.step) {
      state.last = null;
      return { changed: true };
    }
    return { changed: false };
  }

  if (type !== "assistant/message" && type !== "assistant/attempt") return { changed: false }; // turn/end 等一律无视

  // 采样口径对齐官方 usageOf（dsh-token-meter）：message 顶层 usage 优先，
  // 缺失时回落 stream 末块 usage（message 事件同样携带 stream 字段——实测），
  // 两处都没有才算「无 usage 跳过」；attempt 一律走 stream 末块。
  const usage = type === "assistant/message" && data?.usage !== void 0 ? data.usage : lastAttemptUsage(data);
  if (usage === void 0 || usage === null) return { changed: false }; // usage 可缺（SPEC §1），缺=无变化

  const buckets = bucketsFromUsage(usage);
  if (buckets === void 0 || !BUCKET_KEYS.every((key) => Number.isFinite(buckets[key]))) {
    // 非法样本（非有限数）按无变化丢弃：NaN 一旦进 totals 会毒化全部后续聚合，宁丢一条
    return { changed: false };
  }

  const sameKey = state.last !== null && state.last.turn === data?.turn && state.last.step === data?.step;
  const previous = sameKey ? state.last.buckets : null;
  if (previous !== null && BUCKET_KEYS.every((key) => previous[key] === buckets[key])) {
    return { changed: false }; // 同键同值 no-op（官方投影去重）
  }

  const base = previous ?? ZERO_BUCKETS;
  const delta = {};
  for (const key of BUCKET_KEYS) {
    const diff = buckets[key] - base[key];
    delta[key] = diff;
    state.totals[key] += diff;
  }
  state.last = { turn: data?.turn, step: data?.step, buckets };
  return { changed: true, delta, kind: previous !== null ? "replace" : "add" };
}
