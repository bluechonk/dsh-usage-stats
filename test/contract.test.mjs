// 接口测试：锚定宿主事件形状与内核会话文件格式。DSH 升级若改动任一形状，这里先红。
// 样例取自 DSH 会话文件（0.2.0-rc.2，已脱敏：content/stream 体裁去，结构逐字段保留；
// 顶层 time 亦为合成值——夹具不依赖具体时间，仅固定事件形状）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import {
  cutInheritedEvents,
  decompressSessionFile,
  resolveConfig,
  zstdFrameOffsets,
} from "../lib/index.js";
import { applyEvent, createFoldState } from "../lib/fold.js";

function test31(name, fn) {
  return test(name, { timeout: 5000 }, fn);
}

// ---- 形状哨兵：assistant/message（取自 DSH 会话文件格式的例子）----
const REAL_MESSAGE_EVENT = {
  type: "assistant/message",
  seq: 17,
  time: 1700000000000, // 合成时间戳（2023-11-14T22:13:20Z）：非真实会话时间
  data: {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [],
      source: {
        kind: "model",
        provider: "example-provider",
        model: "example/model-name",
        // replayState 是每个 pi-ai 消息的常规字段，不是 fork 标记——在此存在以固定该事实
        replayState: { response: { kind: "pi-ai", provider: "example-provider", model: "example/model-name" }, blocks: [] },
      },
      id: "11111111-2222-4333-8444-555555555555",
    },
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    stream: [],
  },
};

// assistant/attempt：usage 嵌 stream 末块（官方 usageOf 口径）
const REAL_ATTEMPT_EVENT = {
  type: "assistant/attempt",
  seq: 21,
  time: 1700000005000, // 合成时间戳：比上一条晚 5 秒，仅为保持事件时序可读
  data: {
    turn: 1,
    step: 2,
    stream: [
      { type: "chunk", chunk: { type: "text-delta", text: "…" } },
      { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 900, outputTokens: 40 } } },
    ],
  },
};

test31("哨兵：assistant/message 真实形状 → fold 产出 add 增量，uncachedInput=原始 inputTokens", () => {
  const state = createFoldState();
  const result = applyEvent(state, REAL_MESSAGE_EVENT);
  assert.equal(result.changed, true);
  assert.equal(result.kind, "add");
  assert.deepEqual(result.delta, {
    uncachedInputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test31("哨兵：assistant/attempt 从 stream 末块采 usage（message.source 缺席时不炸）", () => {
  const state = createFoldState();
  const result = applyEvent(state, REAL_ATTEMPT_EVENT);
  assert.equal(result.changed, true);
  assert.equal(result.kind, "add");
  assert.equal(result.delta.uncachedInputTokens, 900);
  assert.equal(result.delta.outputTokens, 40);
});

test31("哨兵：retry 闭环——message 同键替换 + retry-started 清槽后累加", () => {
  const state = createFoldState();
  applyEvent(state, REAL_MESSAGE_EVENT);
  // 同 (turn,step) 更大样本 → replace 差值
  const bigger = structuredClone(REAL_MESSAGE_EVENT);
  bigger.data.usage = { inputTokens: 14000, outputTokens: 900, totalTokens: 14900 };
  const replace = applyEvent(state, bigger);
  assert.equal(replace.kind, "replace");
  assert.equal(replace.delta.uncachedInputTokens, 13000); // 14000 - 1000
  // retry-started 清槽
  const retry = applyEvent(state, { type: "llm/retry-started", seq: 30, time: 1, data: { turn: 1, step: 1 } });
  assert.equal(retry.changed, true);
  // 同键再采样 → 累加（add）
  const retried = structuredClone(REAL_MESSAGE_EVENT);
  retried.seq = 31;
  const add = applyEvent(state, retried);
  assert.equal(add.kind, "add");
  assert.equal(state.totals.uncachedInputTokens, 14000 + 1000);
});

test31("哨兵：message 缺顶层 usage 时回落 stream 末块（官方 usageOf 同语义）", () => {
  const state = createFoldState();
  const event = structuredClone(REAL_MESSAGE_EVENT);
  delete event.data.usage; // 中断/未结算消息：顶层 usage 缺席
  event.data.stream = [
    { type: "chunk", chunk: { type: "text-delta", text: "…" } },
    { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 777, outputTokens: 22 } } },
  ];
  const result = applyEvent(state, event);
  assert.equal(result.changed, true);
  assert.equal(result.delta.uncachedInputTokens, 777);
  // 两处都没有才是「无 usage」
  const bare = structuredClone(event);
  bare.data.stream = [];
  assert.equal(applyEvent(state, bare).changed, false);
});

test31("哨兵：非有限样本（NaN/缺字段）按无变化丢弃，不毒化 totals（有意偏离官方）", () => {
  const state = createFoldState();
  applyEvent(state, REAL_MESSAGE_EVENT);
  const bad = structuredClone(REAL_MESSAGE_EVENT);
  bad.seq = 99;
  bad.data.usage = { inputTokens: Number.NaN, outputTokens: 5 };
  assert.equal(applyEvent(state, bad).changed, false);
  assert.equal(state.totals.uncachedInputTokens, 1000); // totals 未被 NaN 毒化
});

test31("多帧 zstd 会话文件：逐帧解压还原全部行（单帧 Sync 只解第一帧）", () => {
  const frame1 = zstdCompressSync(Buffer.from('{"type":"session","version":4}\n{"type":"turn/start","seq":1}\n', "utf8"));
  const frame2 = zstdCompressSync(Buffer.from('{"type":"turn/end","seq":2}\n', "utf8"));
  const joined = Buffer.concat([frame1, frame2]);
  assert.ok(zstdFrameOffsets(joined).length === 2, "应扫出两个帧边界");
  const { text, frames, lostFrames } = decompressSessionFile(joined);
  assert.equal(frames, 2);
  assert.equal(lostFrames, 0);
  assert.deepEqual(
    text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).type),
    ["session", "turn/start", "turn/end"],
  );
});

test31("fork 剪切：inherited 标记（含）之前的事件全部剪除，之后保留", () => {
  const events = [
    { type: "assistant/message", seq: 0, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
    { type: "assistant/message", seq: 1, time: 2, data: { turn: 1, step: 2, usage: { inputTokens: 2, outputTokens: 2 } } },
    { type: "session/end-seed", seq: 2, time: 2, data: { inherited: true } },
    { type: "turn/end", seq: 3, time: 3, data: { reason: { kind: "forked" } } },
    { type: "assistant/message", seq: 4, time: 4, data: { turn: 2, step: 1, usage: { inputTokens: 5, outputTokens: 5 } } },
  ];
  const kept = cutInheritedEvents(events);
  assert.deepEqual(kept.map((e) => e.seq), [3, 4]);
  // 无标记 → 原样
  assert.equal(cutInheritedEvents(events.slice(0, 2)).length, 2);
});

test31("fork 全量重放对账：父会话与剪切后子会话的总和 == 各自独立 fold 之和（无双计）", () => {
  const parent = createFoldState();
  for (const e of eventsOfParent()) applyEvent(parent, e);
  const child = createFoldState();
  for (const e of cutInheritedEvents(eventsOfChild())) applyEvent(child, e);
  // 子会话只算新事件：总量 = 父(3) + 子新增(5)
  assert.equal(parent.totals.uncachedInputTokens + child.totals.uncachedInputTokens, 8);
});

function eventsOfParent() {
  return [
    { type: "assistant/message", seq: 0, time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 0 } } },
    { type: "assistant/message", seq: 1, time: 2, data: { turn: 1, step: 2, usage: { inputTokens: 2, outputTokens: 0 } } },
  ];
}
function eventsOfChild() {
  return [
    ...eventsOfParent(),
    { type: "session/end-seed", seq: 2, time: 2, data: { inherited: true } },
    { type: "assistant/message", seq: 3, time: 4, data: { turn: 2, step: 1, usage: { inputTokens: 5, outputTokens: 0 } } },
  ];
}

test31("resolveConfig：缺省开、默认目录；未知键抛；enabled:false 显式关", () => {
  const cfg = resolveConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.storageRoot.includes("usage-stats"));
  assert.ok(cfg.sessionsRoot.includes("sessions"));
  assert.equal(resolveConfig({ enabled: false }).enabled, false);
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/);
});
