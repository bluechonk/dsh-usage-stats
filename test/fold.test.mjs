// dsh-usage-stats — fold 折叠语义用例（SPEC §2/§8）。
// 五类语义各一条独立 test，互不共享状态；事件构造器严格按SPEC §1 形状（字段全名）。
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, bucketsFromUsage, createFoldState, lastAttemptUsage } from "../lib/fold.js";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// ---- 事件构造器（SPEC §1） ----

// usage 原始形状：cache 两项为 0 时官方字段缺省——故只在显式给值时才写键
function makeUsage({ inputTokens, outputTokens, cacheRead, cacheWrite } = {}) {
  const usage = { inputTokens, outputTokens };
  if (cacheRead !== void 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== void 0) usage.cacheWriteTokens = cacheWrite;
  usage.totalTokens = inputTokens + outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return usage;
}

function messageEvent(turn, step, usage) {
  const data = { message: { source: { provider: "deepseek", model: "deepseek-chat" } }, turn, step };
  if (usage !== void 0) data.usage = usage; // "无 usage"用例要求字段真缺，而非 undefined 值
  return { type: "assistant/message", data };
}

// stream 记录形状：{type:"chunk", chunk:{type,…}}；usage 块的 usage 挂在 chunk.usage
function attemptEvent(turn, step, chunks) {
  return {
    type: "assistant/attempt",
    data: { turn, step, stream: chunks.map((chunk) => ({ type: "chunk", chunk })) },
  };
}

function retryEvent(turn, step) {
  return { type: "llm/retry-started", data: { turn, step } };
}

const textChunk = (text) => ({ type: "text-delta", text });
const usageChunk = (usage) => ({ type: "usage", usage });

test("fold① 同键替换：后样本换前样本，差值桶可为负", { timeout: 5000 }, () => {
  const state = createFoldState();
  const a = makeUsage({ inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 20 });
  const b = makeUsage({ inputTokens: 120, outputTokens: 40 }); // cache 缺省=0 → 差值桶出现负数
  const r1 = applyEvent(state, messageEvent(3, 1, a));
  assert.equal(r1.changed, true);
  assert.equal(r1.kind, "add");
  assert.deepEqual(r1.delta, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20 });

  const r2 = applyEvent(state, messageEvent(3, 1, b));
  assert.equal(r2.changed, true);
  assert.equal(r2.kind, "replace");
  assert.deepEqual(r2.delta, { uncachedInputTokens: 20, outputTokens: -10, cacheReadTokens: -10, cacheWriteTokens: -20 });
  // totals 语义 = 替换槽 LWW：终值即后样本 b
  assert.deepEqual(state.totals, { uncachedInputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("fold② retry-started 清槽后同键改累加", { timeout: 5000 }, () => {
  const state = createFoldState();
  applyEvent(state, messageEvent(1, 1, makeUsage({ inputTokens: 100, outputTokens: 50 })));

  const cleared = applyEvent(state, retryEvent(1, 1));
  // 清槽是状态变化但不产生增量：宿主凭 delta 缺席不落 record，totals 不动
  assert.deepEqual(cleared, { changed: true });
  assert.deepEqual(state.totals, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const r2 = applyEvent(state, messageEvent(1, 1, makeUsage({ inputTokens: 30, outputTokens: 8 })));
  assert.equal(r2.kind, "add"); // 槽已清：同键不再替换而是累加
  assert.deepEqual(r2.delta, { uncachedInputTokens: 30, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(state.totals, { uncachedInputTokens: 130, outputTokens: 58, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("fold③ interrupted message：usage 存在照常计入（官方口径，失败尝试也计）", { timeout: 5000 }, () => {
  // 官方口径 = 有 usage 就计，不区分轮次成败——构造带 usage 的 message 即可
  const state = createFoldState();
  const r = applyEvent(state, messageEvent(2, 1, makeUsage({ inputTokens: 7, outputTokens: 3, cacheWrite: 4 })));
  assert.equal(r.changed, true);
  assert.equal(r.kind, "add");
  assert.deepEqual(state.totals, { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 4 });
});

test("fold④ 无 usage 的 message 跳过", { timeout: 5000 }, () => {
  const state = createFoldState();
  assert.deepEqual(applyEvent(state, messageEvent(1, 1, void 0)), { changed: false });
  assert.deepEqual(state.totals, ZERO);
});

test("fold⑤ attempt stream 采样：乱序取 usage 块、从后往前、无 usage 无变化", { timeout: 5000 }, () => {
  const state = createFoldState();
  // usage 块夹在两条 text-delta 中间也能取到
  const r1 = applyEvent(state, attemptEvent(4, 2, [textChunk("x"), usageChunk(makeUsage({ inputTokens: 11, outputTokens: 5, cacheRead: 2 })), textChunk("y")]));
  assert.equal(r1.changed, true);
  assert.equal(r1.kind, "add");
  assert.deepEqual(r1.delta, { uncachedInputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 });

  // 官方语义是"从后往前"第一条：两条 usage 并存时必须取末尾那条
  const r2 = applyEvent(state, attemptEvent(4, 3, [usageChunk(makeUsage({ inputTokens: 1, outputTokens: 1 })), usageChunk(makeUsage({ inputTokens: 2, outputTokens: 2 }))]));
  assert.deepEqual(r2.delta, { uncachedInputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });

  // 无 usage 块的 attempt → 无变化
  assert.deepEqual(applyEvent(state, attemptEvent(4, 4, [textChunk("a"), textChunk("b")])), { changed: false });
  assert.deepEqual(state.totals, { uncachedInputTokens: 13, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 0 });
});

test("fold⑥ retry-started 键不匹配不清槽：后续同键仍走替换", { timeout: 5000 }, () => {
  const state = createFoldState();
  applyEvent(state, messageEvent(1, 1, makeUsage({ inputTokens: 10, outputTokens: 1 })));
  assert.deepEqual(applyEvent(state, retryEvent(1, 2)), { changed: false }); // step 不同

  // 槽未被误清：同键下一样本必须是替换（差值换算），而非从 0 累加
  const r2 = applyEvent(state, messageEvent(1, 1, makeUsage({ inputTokens: 4, outputTokens: 4 })));
  assert.equal(r2.kind, "replace");
  assert.deepEqual(state.totals, { uncachedInputTokens: 4, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("fold⑦ totalTokens 不落桶", { timeout: 5000 }, () => {
  const state = createFoldState();
  const r = applyEvent(state, messageEvent(1, 1, makeUsage({ inputTokens: 5, outputTokens: 6, cacheRead: 1, cacheWrite: 2 })));
  assert.deepEqual(Object.keys(r.delta).sort(), ["cacheReadTokens", "cacheWriteTokens", "outputTokens", "uncachedInputTokens"]);
  assert.ok(!("totalTokens" in r.delta));
  assert.ok(!("totalTokens" in state.totals));
  // bucketsFromUsage 直接取 inputTokens（不减缓存），且不产 totalTokens 键
  assert.deepEqual(
    bucketsFromUsage(makeUsage({ inputTokens: 5, outputTokens: 6, cacheRead: 1, cacheWrite: 2 })),
    { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 2 },
  );
});

test("fold⑧ 非 token 事件（turn/end、未知类型）一律无变化", { timeout: 5000 }, () => {
  const state = createFoldState();
  assert.deepEqual(applyEvent(state, { type: "turn/end", data: { reason: { kind: "completed" } } }), { changed: false });
  assert.deepEqual(applyEvent(state, { type: "session/whatever", data: {} }), { changed: false });
  assert.deepEqual(state.totals, ZERO);
});

test("fold⑨ lastAttemptUsage 直测：无 stream / 无 usage 块均 undefined", { timeout: 5000 }, () => {
  const u = makeUsage({ inputTokens: 3, outputTokens: 4 });
  assert.equal(lastAttemptUsage({ turn: 1, step: 1, stream: [{ type: "chunk", chunk: textChunk("a") }, { type: "chunk", chunk: usageChunk(u) }] }), u);
  assert.equal(lastAttemptUsage({ turn: 1, step: 1, stream: [{ type: "chunk", chunk: textChunk("a") }] }), void 0);
  assert.equal(lastAttemptUsage({}), void 0);
  assert.equal(lastAttemptUsage(void 0), void 0);
});
