// 回归测试：
//   ①live 采集过的会话经「重启 → auto-backfill」不再整文件重折双计（水位法）
//   ②marker v1（无 watermarks）读兼容
//   ③close 的锁归属校验：他人锁不删
// 全部走 mock ctx 驱动真实 apply()，不改任何生产代码路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { apply } from "../lib/index.js";

function test31(name, fn) {
  return test(name, { timeout: 10000 }, fn);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** mock logger：纯空实现（历史上的环境变量调试门控已移除，测试不再有任何日志旁路）。 */
const mockLogger = { info() {}, warn() {}, error() {} };

/** mock 宿主上下文：记录订阅/路由/生命周期，够 index.js apply 跑通采集→回填→清理全链。 */
function makeMockCtx() {
  const handlers = {};
  const disposers = [];
  return {
    handlers,
    disposers,
    on: (type, fn) => { handlers[type] = fn; },
    inject: (_deps, fn) => {
      fn({
        webServer: { register: () => () => {} }, // 路由注册桩：宿主侧已另行验证
        effect: (setup) => {
          const dispose = setup();
          if (typeof dispose === "function") disposers.push(dispose);
          return dispose;
        },
      });
    },
    effect: (setup) => {
      const dispose = setup();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    logger: mockLogger,
  };
}

function msgEvent(sid, seq, turn, input, time) {
  return {
    type: "assistant/message",
    seq,
    time,
    data: { turn, step: 1, message: { source: { kind: "model", provider: "prov", model: "m1" } }, usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10 } },
  };
}

/** 造一个会话文件（多帧 zstd 拼接的真实形态由 decompressSessionFile 兼容单帧）。 */
function writeSessionFile(sessionsRoot, ws, sid, events) {
  const dir = join(sessionsRoot, ws, sid);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(lines, "utf8")));
}

/** 向既有会话文件追加事件（新 zstd 帧，模拟内核追加块写入形态）。 */
function appendSessionEvents(sessionsRoot, ws, sid, events) {
  const file = join(sessionsRoot, ws, sid, "session.v4.jsonl.zstd");
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, Buffer.concat([readFileSync(file), zstdCompressSync(Buffer.from(lines, "utf8"))]));
}

function recordsOf(storageRoot) {
  const out = [];
  for (const name of ["records-2026-01.jsonl", "records-2026-02.jsonl"]) {
    const p = join(storageRoot, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

/** 全量流水（任意月份）：文件名序 + 行序——与 store.readAllRecords 同语义，测试侧独立实现。 */
function recordsAll(storageRoot) {
  const out = [];
  for (const name of readdirSync(storageRoot).sort()) {
    if (!/^records-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    for (const line of readFileSync(join(storageRoot, name), "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

/** 捕获路由的 mock ctx（inline 形态收敛成工厂）：routes 供直调 handler 伪造 req/res。 */
function makeRouteCaptureCtx() {
  const routes = [];
  const handlers = {};
  const disposers = [];
  return {
    routes,
    handlers,
    disposers,
    on: (type, fn) => { handlers[type] = fn; },
    inject: (_deps, fn) => {
      fn({
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
        effect: (setup) => { const d = setup(); if (typeof d === "function") disposers.push(d); },
      });
    },
    effect: (setup) => { const d = setup(); if (typeof d === "function") disposers.push(d); },
    logger: mockLogger,
  };
}

/** 直调 exact 路由 handler（req/res 伪造同款），收 {status, body}。 */
function callRoute(route, method, url) {
  return new Promise((resolve) => {
    let status = 0;
    route.handler(
      { method, url, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1" } },
      {
        writeHead: (s) => { status = s; },
        end: (b) => { resolve({ status, body: b }); },
      },
    );
  });
}

const BACKFILL_URL = "/api/dsh-usage-stats/backfill";
const STATUS_URL = "/api/dsh-usage-stats/backfill/status";

/** 毫秒 → 本地 "YYYY-MM-DD"（与 aggregate.isoOf 同口径，测试侧独立实现）。 */
function isoLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const T0 = new Date(2026, 0, 15, 10, 0, 0).getTime(); // 2026-01-15 本地

test31("live 采集 → 重启 → auto-backfill 不双计（水位法）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-live-1";
    // 先放 3 条历史事件：首次装载 auto-backfill 全量折
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 1000),
      msgEvent(sid, 3, 3, 300, T0 + 2000),
    ]);

    // —— 第一个实例：装载（auto-backfill 折 3 条）→ live 再采 1 条（seq 4）——
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(50); // setImmediate：auto-backfill 跑完
    let records = recordsOf(storageRoot);
    assert.equal(records.length, 3, "首轮回填 3 条");
    const liveHandler = ctx1.handlers["session/event"];
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 4, 4, 400, T0 + 3000));
    records = recordsOf(storageRoot);
    assert.equal(records.length, 4, "live 增量第 4 条");
    // 模拟优雅重启：生命周期清理（内部会强制 flush 脏水位/日档）
    for (const dispose of ctx1.disposers) await dispose();

    // —— 第二个实例：装载即 auto-backfill。修复前：会话 B 不在 done → 整文件重折 → 7 条 ——
    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(50);
    records = recordsOf(storageRoot);
    assert.equal(records.length, 4, `重启后回填只补水位后增量，仍 4 条（双计则会是 7）`);
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 100 + 200 + 300 + 400, "四桶求和 == 官方 totals 口径，无双计");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("live 续采的已回填会话重启后，尾部增量补齐且不双计（水位优先于 done）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it2-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-live-2";
    // 真实时序：装载时文件只有 2 条 → auto-backfill 全量折+done → live 续采这 2 条 →
    // 用户继续对话，文件追加 3 条 → 重启 → 回填应按水位只补 3..5
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 1000),
    ]);
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(50); // auto-backfill：折 2 条，done+水位=2
    let records = recordsOf(storageRoot);
    assert.equal(records.length, 2, "首轮回填 2 条");
    // 用户继续对话：live 见新事件（seq3）同时文件尾部追加 3 条（live 期由 fold 终态续算，水位随事件推进）
    appendSessionEvents(sessionsRoot, ws, sid, [
      msgEvent(sid, 3, 3, 300, T0 + 2000),
      msgEvent(sid, 4, 4, 400, T0 + 3000),
      msgEvent(sid, 5, 5, 500, T0 + 4000),
    ]);
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 300, T0 + 2000));
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 4, 4, 400, T0 + 3000));
    records = recordsOf(storageRoot);
    assert.equal(records.length, 4, "live 续采 seq3/4（终态续算，turn3/4 新键 add）");
    for (const dispose of ctx1.disposers) await dispose(); // 重启（清理强制落盘水位=4）
    // —— 新实例：水位=4，文件末尾=5 → 只补 seq5；随后 live 继续新轮次 seq6 ——
    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(50);
    records = recordsOf(storageRoot);
    assert.equal(records.length, 5, `回填按水位只补 seq5，共 5 条（done 优先则会永远丢 5）`);
    ctx2.handlers["session/event"]({ id: sid }, msgEvent(sid, 6, 6, 600, T0 + 5000));
    records = recordsOf(storageRoot);
    assert.equal(records.length, 6, "重启后 live 新轮次正常记账");
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 100 + 200 + 300 + 400 + 500 + 600, "无双计无丢失");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("marker v1（无 watermarks）读兼容：旧文件升级后回填走 done 跳过", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it3-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    mkdirSync(storageRoot, { recursive: true });
    const sid = "sess-old";
    writeFileSync(join(storageRoot, "backfill-marker.json"), JSON.stringify({ done: [sid], updatedAt: 1 }));
    writeSessionFile(sessionsRoot, "--ws--", sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
    ]);
    // 另一个未 done 的新会话：触发 marker 实际落盘（无变更不写盘）
    const sid2 = "sess-new";
    writeSessionFile(sessionsRoot, "--ws--", sid2, [
      { type: "session", version: 4, id: "y", createdAt: T0 },
      msgEvent(sid2, 1, 1, 700, T0),
    ]);
    const ctx = makeMockCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(50);
    const records = recordsOf(storageRoot);
    assert.equal(records.length, 1, "done 会话不重折，只有新会话的 1 条");
    assert.equal(records[0].sessionId, sid2);
    const marker = JSON.parse(readFileSync(join(storageRoot, "backfill-marker.json"), "utf8"));
    assert.equal(marker.done.includes(sid), true, "v1 done 保留");
    assert.equal(marker.done.includes(sid2), true, "新会话入 done");
    assert.equal(Number(marker.watermarks[sid]), 1, "v1 done 会话经 bootstrap 建基线水位（marker v4：watermarks 语义=bootstrap 基线）");
    assert.equal(records[0].seq, 1, "新会话的记账水位由 records 推导（record 带 seq 字段），不再写进 marker.watermarks");
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("替换窗跨进程边界——回填 fold 全文件重放，槽基线不丢", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it5-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-replace";
    const sameKey = (seq, input) => msgEvent(sid, seq, 1, input, T0 + seq * 10);
    // 时序：live 见 seq1（input 50，记账 add:50，水位=1）→ 同键替换样本 seq2（input 300）落入文件 → 进程死
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      sameKey(1, 50),
    ]);
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(50);
    ctx1.handlers["session/event"]({ id: sid }, sameKey(1, 50));
    appendSessionEvents(sessionsRoot, ws, sid, [sameKey(2, 300)]); // 死窗内落盘的替换样本
    // 不 dispose（模拟 SIGKILL）；锁拨旧让新实例直接接管
    const { utimesSync } = await import("node:fs");
    const lockPath = join(storageRoot, "lock");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(50);
    const records = recordsOf(storageRoot);
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 300, `增量流求和 == 官方 totals 300（基线丢失则 50+300=350）`);
    const replaceRow = records.find((r) => r.kind === "replace");
    assert.ok(replaceRow, "补的应是 replace 差值 250");
    assert.equal(replaceRow.usage.uncachedInputTokens, 250);
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("SIGKILL 后从 records 推导水位——重启回填不双计（架构解适配）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it6-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-kill";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(50);
    const markerPath = join(storageRoot, "backfill-marker.json");
    const markerAfterBackfill = readFileSync(markerPath, "utf8"); // 首轮回填后的盘上快照
    // live 采一条文件外新增（真实时序：先 append 文件再发事件）
    appendSessionEvents(sessionsRoot, ws, sid, [msgEvent(sid, 3, 3, 300, T0 + 20)]);
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 300, T0 + 20));
    assert.equal(recordsOf(storageRoot).length, 3, "live 采 3 条");
    // live 完全不写 marker——record 已 appendFileSync 同步落盘，水位由 records 推导
    assert.equal(readFileSync(markerPath, "utf8"), markerAfterBackfill, "live 落 record 后盘上 marker 字节不变");
    // 不 dispose（SIGKILL）：盘上 marker 的水位没跟上 live 进度也无妨——records 每条同步落盘，
    // 重启从 records 推导水位=3；锁拨旧即接管
    const { utimesSync } = await import("node:fs");
    const lockPath = join(storageRoot, "lock");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(50);
    const records = recordsOf(storageRoot);
    assert.equal(records.length, 3, "重启回填从 records 推导水位，不重折不双计（崩溃窗零丢失）");
    assert.equal(records.filter((r) => r.seq === 3).length, 1, "推导水位=records 按 sid 聚合 max(seq)：崩溃前最后一条恰好记账一次");
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 600, "总账 600 无双计");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("崩溃窗丢的防抖日档在下次启动自愈（daily 真源重建）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it7-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-daily";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(80);
    // live 采一条并立即强杀（不 dispose）——2s 防抖窗内 daily 未落盘，records/水位已同步落盘
    appendSessionEvents(sessionsRoot, ws, sid, [msgEvent(sid, 3, 3, 300, T0 + 20)]);
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 300, T0 + 20));
    // 直接删掉 daily 模拟「崩溃窗防抖未落盘」（比掐时更确定性）：records 是唯一真源
    rmSync(join(storageRoot, "daily"), { recursive: true, force: true });
    const { utimesSync } = await import("node:fs");
    const lockPath = join(storageRoot, "lock");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(150);
    const dailyFiles = existsSync(join(storageRoot, "daily")) ? readdirSync(join(storageRoot, "daily")) : [];
    assert.ok(dailyFiles.length > 0, "重启后 daily 被按 records 重建");
    const daily = JSON.parse(readFileSync(join(storageRoot, "daily", dailyFiles[0]), "utf8"));
    const total = Object.values(daily.byModel).reduce((acc, b) => acc + (b.uncachedInputTokens || 0), 0);
    assert.equal(total, 100 + 200 + 300, `daily 从真源重建含全部记账（此前崩溃窗会永久丢 300）`);
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("装载后回填前的 live 事件不抹盘上 marker（清空窗：live 不写 marker）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it8-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    // 盘上预置 v2 marker：34 会话 done + 一个已知水位（模拟已有数据形态）
    const presetSids = Array.from({ length: 33 }, (_, i) => `preset-${i}`);
    const sid = "sess-live-now";
    mkdirSync(storageRoot, { recursive: true });
    const presetJson = JSON.stringify({
      done: [...presetSids, sid],
      watermarks: { [sid]: 2 },
      mtimes: {},
      updatedAt: 1,
    });
    const markerPath = join(storageRoot, "backfill-marker.json");
    writeFileSync(markerPath, presetJson);
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const ctx = makeMockCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    // 关键时序：auto-backfill 在 setImmediate 里，此事件更早——装载后回填前窗
    ctx.handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 300, T0 + 20));
    await sleep(150);
    // live 落 record 不再有 marker 写点；回填读到的账（推导水位=3）无需写盘——
    // 盘上 marker 与预置字节级一致（清空窗不是被防住，是架构上不存在了）
    assert.equal(readFileSync(markerPath, "utf8"), presetJson, "live 落 record + 零变更回填后，盘上 marker 字节不变（无清空窗）");
    const marker = JSON.parse(presetJson);
    assert.ok(marker.done.length >= 34, "预置 done 完整（水位语义收窄为 bootstrap 基线后，live 会话的记账在 records 不在 marker）");
    const records = recordsOf(storageRoot);
    assert.equal(records.length, 1, "预置水位=2 已记账 seq1/2，唯一增量是 live 的 seq3");
    assert.equal(records[0].seq, 3, "record 带 seq 字段（推导水位的原料）");
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 300, "全量重折则是 600，推导水位挡住");
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("done-only 会话经 mtime 哨兵 bootstrap 水位，此后增量可补且不双计", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it9-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-doneonly";
    // v1 时代形态：marker 只有 done，无水位；文件已含 2 条历史
    mkdirSync(storageRoot, { recursive: true });
    writeFileSync(join(storageRoot, "backfill-marker.json"), JSON.stringify({ done: [sid], updatedAt: 1 }));
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    // 第一次装载：bootstrap（求 maxSeq 写水位，不 append）
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(150);
    let records = recordsOf(storageRoot);
    assert.equal(records.length, 0, "bootstrap 不补历史（宁漏不双计）");
    let marker = JSON.parse(readFileSync(join(storageRoot, "backfill-marker.json"), "utf8"));
    assert.equal(Number(marker.watermarks[sid]), 2, "水位已建=文件末尾 seq");
    for (const dispose of ctx1.disposers) await dispose();

    // 停用窗后重新启用 + 文件增长：水位路径正常补增量
    appendSessionEvents(sessionsRoot, ws, sid, [msgEvent(sid, 3, 3, 300, T0 + 20)]);
    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(150);
    records = recordsOf(storageRoot);
    assert.equal(records.length, 1, "bootstrap 后的增量可补");
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 300, "补的正是停用窗那条");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("幽灵写者——锁被接管后心跳触发降级，不再覆写 marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it10-"));
  try {
    const storageRoot = join(root, "stats");
    const { createStore } = await import("../lib/store.js");
    const log = { info() {}, warn() {}, error() {} };
    // 实例 A 持锁；模拟睡眠唤醒竞速后 B 接管（锁内容 pid 改写）
    const a = createStore({ storageRoot, log });
    a.acquireLock();
    writeFileSync(join(storageRoot, "lock"), JSON.stringify({ pid: 888888, at: Date.now() }));
    // A 心跳：应抛 LOCK_LOST（不校验则成功拨他人锁=幽灵写者）
    let thrown = null;
    try {
      a.touchLock();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "touchLock 对他人锁必须抛");
    assert.equal(thrown.code, "LOCK_LOST", "错误带 LOCK_LOST 类型码（降级联动判据）");
    // B 正常续期不受影响
    writeFileSync(join(storageRoot, "lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    a.touchLock(); // pid 相同（单进程）→ 正常续期
    a.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("回填期 append 失败不推水位——磁盘恢复后下轮补齐", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it11-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-diskfail";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
      msgEvent(sid, 3, 3, 300, T0 + 20),
    ]);
    // records 目标路径被同名目录占位 → append 全失败（模拟磁盘/权限故障）
    const { mkdirSync: mk } = await import("node:fs");
    mk(join(storageRoot, "records-2026-01.jsonl"), { recursive: true });
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(150);
    // 零固化断言：append 全失败时 marker 要么不存在要么无该 sid 水位/mtimes（写了=mtime 哨兵把故障窗固化）
    const markerPath = join(storageRoot, "backfill-marker.json");
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(Number(marker.watermarks?.[sid] ?? 0), 0, "append 全失败水位不推进（故障窗越过则=3）");
      assert.equal(Number.isFinite(Number(marker.mtimes?.[sid])), false, "append 全失败不写 mtime 哨兵（写了=故障窗固化）");
    }
    for (const dispose of ctx1.disposers) await dispose(); // 释放锁（模拟进程正常退出——不释放则 ctx2 降级镜像）
    // 磁盘恢复：删占位目录，重新装载回填 → 全部补齐
    rmSync(join(storageRoot, "records-2026-01.jsonl"), { recursive: true, force: true });
    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(150);
    const records = recordsOf(storageRoot);
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 600, "恢复后下轮回填补齐全部（水位曾越过则永远 0）");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("close 锁归属校验：他人接管后的锁不被误删", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-it4-"));
  try {
    const storageRoot = join(root, "stats");
    const { createStore } = await import("../lib/store.js");
    const log = { info() {}, warn() {}, error() {} };
    const a = createStore({ storageRoot, log });
    a.acquireLock();
    // 模拟陈旧接管：把锁 mtime 拨旧，另一实例接管
    const lockPath = join(storageRoot, "lock");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(lockPath, old, old);
    const b = createStore({ storageRoot, log });
    b.acquireLock(); // 接管成功
    // 单进程内 pid 相同，模拟接管者=另一进程：改写锁内容为不存在的 pid
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
    a.close(); // a 苏醒释放：应检测到锁非己有而跳过
    assert.equal(existsSync(lockPath), true, "a 释放时不删他人的锁");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() })); // 还原 b 的归属
    b.close();
    assert.equal(existsSync(lockPath), false, "b 正常释放");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 记录真源架构：③水位推导 / ④条件重建 / ⑤按日索引 ----

test31("record 含 seq 字段——回填侧与 live 侧都带", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-seq-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-seq";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 1000),
    ]);
    const ctx = makeMockCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(50);
    let records = recordsAll(storageRoot);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.seq), [1, 2], "回填侧 record 带 event.seq");
    ctx.handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 300, T0 + 2000));
    records = recordsAll(storageRoot);
    assert.equal(records.length, 3);
    assert.equal(records[2].seq, 3, "live 侧 record 带 event.seq");
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("推导水位=records 聚合（含 live append）——整个 marker 删掉重启仍零双计", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-derive-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-derive";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 1000),
      msgEvent(sid, 3, 3, 300, T0 + 2000),
    ]);
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(50);
    ctx1.handlers["session/event"]({ id: sid }, msgEvent(sid, 4, 4, 400, T0 + 3000)); // live append 推高推导水位
    // 文件补上 seq4（file ⊇ live 已见）——最严酷形态：全量重放会看到全部 4 条
    appendSessionEvents(sessionsRoot, ws, sid, [msgEvent(sid, 4, 4, 400, T0 + 3000)]);
    for (const dispose of ctx1.disposers) await dispose();
    // 摧毁 marker：基线/哨兵/done 全部丢失——正确性必须只靠 records 撑住（水位推导=records 聚合）
    rmSync(join(storageRoot, "backfill-marker.json"), { force: true });

    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(150);
    const records = recordsAll(storageRoot);
    assert.equal(records.length, 4, "marker 全丢后从 records 推导水位=4，全量重放零追加（旧架构会重折出 7 条）");
    assert.deepEqual([...new Set(records.map((r) => r.seq))].sort(), [1, 2, 3, 4], "每条 seq 恰好一次");
    const total = records.reduce((acc, r) => acc + r.usage.uncachedInputTokens, 0);
    assert.equal(total, 1000, "总账 1000 无双计");
    assert.equal(existsSync(join(storageRoot, "backfill-marker.json")), false, "零追加不写 marker（marker 丢失只损失哨兵加速，不损正确性）");
    for (const dispose of ctx2.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("marker 瘦身——live 连落 10 条 record，盘上 marker 字节不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-marker-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-marker";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
    ]);
    const ctx = makeMockCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(50); // 首轮回填：marker 落盘（done+mtime）
    const markerPath = join(storageRoot, "backfill-marker.json");
    const before = readFileSync(markerPath, "utf8");
    for (let i = 2; i <= 11; i += 1) {
      ctx.handlers["session/event"]({ id: sid }, msgEvent(sid, i, i, 100 * i, T0 + i * 1000));
    }
    assert.equal(recordsAll(storageRoot).length, 11, "live 落 10 条 record");
    assert.equal(readFileSync(markerPath, "utf8"), before, "盘上 marker 字节不变（live 无 marker 写点；IO 与历史解耦）");
    for (const dispose of ctx.disposers) await dispose();
    assert.equal(readFileSync(markerPath, "utf8"), before, "dispose 兜底也不写 marker（markerDirty=false）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("条件重建——produced=0 且日期集一致时 daily mtime 不变；produced>0 才重建", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-rebuild-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-rebuild";
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 1000),
    ]);
    const dailyFile = join(storageRoot, "daily", isoLocal(T0) + ".json");
    const ctx1 = makeMockCtx();
    apply(ctx1, { storageRoot, sessionsRoot });
    await sleep(80);
    assert.equal(existsSync(dailyFile), true, "首轮回填 produced>0 → daily 重建");
    for (const dispose of ctx1.disposers) await dispose();
    await sleep(60);
    const mtime1 = statSync(dailyFile).mtimeMs;

    // 稳态重启：零新增且日期集一致 → 不重建，daily 原文件不动
    const ctx2 = makeMockCtx();
    apply(ctx2, { storageRoot, sessionsRoot });
    await sleep(120);
    for (const dispose of ctx2.disposers) await dispose();
    const mtime2 = statSync(dailyFile).mtimeMs;
    assert.equal(mtime2, mtime1, "produced=0 且日期集一致 → 零写盘（mtime 不变）");

    // 对照组：文件增长 → produced>0 → 重建触发
    appendSessionEvents(sessionsRoot, ws, sid, [msgEvent(sid, 3, 3, 300, T0 + 2000)]);
    const ctx3 = makeMockCtx();
    apply(ctx3, { storageRoot, sessionsRoot });
    await sleep(120);
    for (const dispose of ctx3.disposers) await dispose();
    const mtime3 = statSync(dailyFile).mtimeMs;
    assert.ok(mtime3 > mtime2, "produced>0 → daily 重建（mtime 前进）");
    const daily = JSON.parse(readFileSync(dailyFile, "utf8"));
    const total = Object.values(daily.byModel).reduce((acc, b) => acc + (b.uncachedInputTokens || 0), 0);
    assert.equal(total, 600, "重建内容含新记录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("recordsOfDate 索引路径与全量过滤一致（经 trend?days=1 黑盒断言）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-index-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-index";
    const now = new Date();
    const atHour = (h, min) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0).getTime();
    const today10 = atHour(10, 30);
    const today12 = atHour(12, 30);
    // 回填产昨日 records（另一日期桶），live 产今日 records——索引跨日期桶各归各
    const yesterday = today10 - 24 * 60 * 60 * 1000;
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: yesterday },
      msgEvent(sid, 1, 1, 100, yesterday),
    ]);
    const routes = [];
    const handlers = {};
    const disposers = [];
    apply(
      {
        on: (type, fn) => { handlers[type] = fn; },
        inject: (_deps, fn) => {
          fn({
            webServer: { register: (route) => { routes.push(route); return () => {}; } },
            effect: (setup) => { const d = setup(); if (typeof d === "function") disposers.push(d); },
          });
        },
        effect: (setup) => { const d = setup(); if (typeof d === "function") disposers.push(d); },
        logger: { info() {}, warn() {}, error() {} },
      },
      { storageRoot, sessionsRoot },
    );
    await sleep(50); // 昨日档回填
    handlers["session/event"]({ id: sid }, msgEvent(sid, 2, 2, 300, today10));
    handlers["session/event"]({ id: sid }, msgEvent(sid, 3, 3, 400, today12));

    const trend = routes.find((r) => r.path === "/api/dsh-usage-stats/trend");
    assert.ok(trend, "trend 路由已注册");
    let body;
    trend.handler(
      { method: "GET", url: "/api/dsh-usage-stats/trend?days=1", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1" } },
      { writeHead() {}, end: (b) => { body = b; } },
    );
    const payload = JSON.parse(body);
    assert.equal(payload.granularity, "hour");
    assert.equal(payload.points.length, 24);
    // 期望值 = 全量过滤语义（旧 recordsOfDate 实现）：recordsAll 过滤今日再按 模型×小时 聚合
    const todayIso = isoLocal(today10);
    const expected = new Map(); // `${hour}|${key}` -> tokens
    for (const record of recordsAll(storageRoot)) {
      if (isoLocal(record.time) !== todayIso) continue;
      const hour = new Date(record.time).getHours();
      const key = `${record.provider}/${record.model}`;
      const k = `${hour}|${key}`;
      expected.set(k, (expected.get(k) ?? 0) + record.usage.uncachedInputTokens + record.usage.outputTokens);
    }
    let totalFromPoints = 0;
    let matched = 0;
    payload.points.forEach((point, hour) => {
      for (const [key, tokens] of Object.entries(point.byModel)) {
        assert.equal(tokens, expected.get(`${hour}|${key}`), `索引路径与全量过滤一致（hour=${hour} key=${key}）`);
        matched += 1;
      }
      totalFromPoints += point.total;
    });
    assert.ok(matched >= 2, "今日两条 record 都被索引路径捞出");
    // 700 输入 + 每条 record 自带 outputTokens 10 → 四桶当量 720；昨日 110 不混入（索引按日期桶隔离）
    assert.equal(totalFromPoints, 720, "今日总量 720（昨日档不混入：索引按日期桶隔离）");
    for (const dispose of disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 回填 202 受理 + GET /backfill/status 进度路由 ----

test31("POST /backfill 立即 202 {ok,started:true}，任务后台完成落盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-bf202-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-bf202";
    const ctx = makeRouteCaptureCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(60); // auto-backfill（空目录）先收尾，别跟 POST 那轮抢 409 闩
    // 装载后再放会话文件：POST 触发的后台回填有真活干（mtime 哨兵不命中、非 done）
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const route = ctx.routes.find((r) => r.path === BACKFILL_URL);
    assert.ok(route, "backfill 路由已注册");
    const { status, body } = await callRoute(route, "POST", BACKFILL_URL);
    assert.equal(status, 202, "受理即返 202（不再挂起到跑完）");
    const payload = JSON.parse(body);
    assert.equal(payload.ok, true, "body.ok === true");
    assert.equal(payload.started, true, "body.started === true");
    assert.equal(recordsAll(storageRoot).length, 0, "202 返回瞬间后台回填尚未跑（下一拍才启动）");
    await sleep(120);
    const records = recordsAll(storageRoot);
    assert.equal(records.length, 2, "后台回填完成：2 条 record 落盘");
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("status 路由 running=true→false，计数递增至终值（真实 runBackfill 跑临时目录）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-bfst-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-bfst";
    const ctx = makeRouteCaptureCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(60);
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const bf = ctx.routes.find((r) => r.path === BACKFILL_URL);
    const st = ctx.routes.find((r) => r.path === STATUS_URL);
    assert.ok(bf && st, "backfill 与 status 路由都已注册");
    await callRoute(bf, "POST", BACKFILL_URL);
    // 受理即 running=true（POST 同步置位，早于下一拍启动的 runBackfill——首查不会误报已完成）
    const runningNow = JSON.parse((await callRoute(st, "GET", STATUS_URL)).body);
    assert.equal(runningNow.running, true, "受理后 status.running=true");
    assert.equal(runningNow.finishedAt, null, "进行中 finishedAt=null");
    // 轮询到 running=false（真实 runBackfill 在后台分片跑）
    let final = null;
    for (let i = 0; i < 50 && final?.running !== false; i += 1) {
      await sleep(20);
      final = JSON.parse((await callRoute(st, "GET", STATUS_URL)).body);
    }
    assert.ok(final !== null && final.running === false, "跑完置 running=false");
    assert.equal(final.scanned, 1, "scanned=会话清单长度");
    assert.equal(final.total, 1, "total=会话清单长度");
    assert.equal(final.backfilled, 1, "backfilled=补的会话数");
    assert.equal(final.records, 2, "records=落盘 record 数（与 recordsAll 一致）");
    assert.equal(final.lostFrames, 0, "完好文件零丢帧");
    assert.ok(Number.isFinite(final.startedAt), "startedAt=epoch ms");
    assert.ok(Number.isFinite(final.finishedAt), "finishedAt=epoch ms");
    assert.ok(final.finishedAt >= final.startedAt, "finishedAt 不早于 startedAt");
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("镜像实例 status 恒 running:false（镜像无回填，进度对象按实例隔离）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-bfmir-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ws = "--ws--";
    const sid = "sess-bfmir";
    // 实例 A 先装载持锁（写者）；实例 B 同 storageRoot 装载 → 抢锁失败降级只读镜像
    const ctxA = makeRouteCaptureCtx();
    apply(ctxA, { storageRoot, sessionsRoot });
    await sleep(60);
    const ctxB = makeRouteCaptureCtx();
    apply(ctxB, { storageRoot, sessionsRoot });
    await sleep(30);
    // A 有真活可干：装载后再放会话文件并 POST A
    writeSessionFile(sessionsRoot, ws, sid, [
      { type: "session", version: 4, id: "x", createdAt: T0 },
      msgEvent(sid, 1, 1, 100, T0),
      msgEvent(sid, 2, 2, 200, T0 + 10),
    ]);
    const bfA = ctxA.routes.find((r) => r.path === BACKFILL_URL);
    const stA = ctxA.routes.find((r) => r.path === STATUS_URL);
    const stB = ctxB.routes.find((r) => r.path === STATUS_URL);
    assert.ok(bfA && stA && stB, "两个实例都注册了路由（镜像不误伤读取面）");
    await callRoute(bfA, "POST", BACKFILL_URL);
    const aNow = JSON.parse((await callRoute(stA, "GET", STATUS_URL)).body);
    const bNow = JSON.parse((await callRoute(stB, "GET", STATUS_URL)).body);
    assert.equal(aNow.running, true, "写者 A 受理后 running=true");
    assert.equal(bNow.running, false, "镜像 B 的 status 恒 running:false（进度对象在 apply 闭包内，跨实例不串台）");
    await sleep(120);
    const aDone = JSON.parse((await callRoute(stA, "GET", STATUS_URL)).body);
    assert.equal(aDone.running, false, "A 后台回填完成 running=false");
    assert.equal(aDone.records, 2, "A 计数到位");
    for (const dispose of ctxA.disposers) await dispose();
    for (const dispose of ctxB.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test31("status 是 GET——POST 打它 405；GET 返回逐字段SPEC形状", async () => {
  const root = mkdtempSync(join(tmpdir(), "dus-pin-bf405-"));
  try {
    const storageRoot = join(root, "stats");
    const sessionsRoot = join(root, "sessions");
    const ctx = makeRouteCaptureCtx();
    apply(ctx, { storageRoot, sessionsRoot });
    await sleep(60);
    const st = ctx.routes.find((r) => r.path === STATUS_URL);
    assert.ok(st, "status 路由已注册");
    const posted = await callRoute(st, "POST", STATUS_URL);
    assert.equal(posted.status, 405, "POST 打 status → 405");
    assert.match(JSON.parse(posted.body).error, /method not allowed/, "405 错误文案");
    const got = await callRoute(st, "GET", STATUS_URL);
    assert.equal(got.status, 200, "GET status → 200");
    const shape = JSON.parse(got.body);
    assert.equal(shape.running, false, "空闲态 running:false");
    for (const key of ["running", "startedAt", "scanned", "total", "backfilled", "records", "lostFrames", "finishedAt"]) {
      assert.ok(key in shape, `status 形状含 ${key}（响应形状SPEC逐字段）`);
    }
    // 装载即 auto-backfill 必跑一轮（空目录零活）：startedAt/finishedAt 已是「最近一轮」时刻，
    // startedAt=null 只在「本实例从未跑过回填」时成立（镜像实例 B 侧即此形态）
    assert.ok(Number.isFinite(shape.startedAt), "auto-backfill 已跑过一轮：startedAt=最近一轮时刻");
    assert.ok(Number.isFinite(shape.finishedAt), "auto-backfill 已收尾：finishedAt=最近一轮时刻");
    for (const key of ["scanned", "total", "backfilled", "records", "lostFrames"]) {
      assert.equal(shape[key], 0, `空目录轮计数归零：${key}=0`);
    }
    for (const dispose of ctx.disposers) await dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
