// dsh-usage-stats — 落盘层用例（SPEC §3/§8）。
// 每条测试独享 mkdtemp 临时目录（禁并行共享目录）；t.after 兜底 rm -rf，
// 异常路径也会执行，等价 finally 清理且不会漏。
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, monthOf } from "../lib/store.js";

// 静音 logger；日志纪律由捕获型 logger 的用例专门断言，其余用例不关心日志
const silent = { info() {}, warn() {}, error() {} };

function captureLog() {
  const calls = { info: [], warn: [], error: [] };
  const push = (level) => (message) => calls[level].push(String(message));
  return { calls, info: push("info"), warn: push("warn"), error: push("error") };
}

function makeRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-usage-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** SPEC §3 record 形状（字段全名，不压缩）的最小合法样本。 */
function record(time, overrides = {}) {
  return {
    time,
    sessionId: "sid-1",
    provider: "deepseek",
    model: "deepseek-chat",
    turn: 3,
    step: 1,
    kind: "add",
    usage: { uncachedInputTokens: 123, outputTokens: 456, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  };
}

test("store: monthOf 取本地时区月份，非法时间戳抛错", { timeout: 5000 }, () => {
  // 一律用本地分量构造 Date，断言与机器时区无关
  assert.equal(monthOf(new Date(2026, 0, 31, 23, 59).getTime()), "2026-01");
  assert.equal(monthOf(new Date(2026, 1, 1, 0, 0).getTime()), "2026-02");
  assert.equal(monthOf(new Date(2026, 9, 3, 12, 0).getTime()), "2026-10");
  assert.throws(() => monthOf(Number.NaN), /monthOf/);
});

test("store: append 两条不同月 → 两个文件各一行；readAllRecords 按月序+行序还原", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const store = createStore({ storageRoot: dir, log: silent });
  const r1 = record(new Date(2026, 8, 15, 12, 0).getTime()); // 本地 9 月
  const r2 = record(new Date(2026, 9, 1, 8, 30).getTime(), {
    kind: "replace",
    usage: { uncachedInputTokens: -20, outputTokens: -5, cacheReadTokens: 0, cacheWriteTokens: 0 }, // replace 负增量合法
  });
  store.append(r1);
  store.append(r2);

  const files = readdirSync(dir).filter((name) => name.startsWith("records-")).sort();
  assert.deepEqual(files, ["records-2026-09.jsonl", "records-2026-10.jsonl"]);
  assert.equal(readFileSync(join(dir, files[0]), "utf8").trimEnd().split("\n").length, 1);
  assert.equal(readFileSync(join(dir, files[1]), "utf8").trimEnd().split("\n").length, 1);
  assert.deepEqual(store.readAllRecords(), [r1, r2]); // 月文件序在前、行序在后
});

test("store: 坏行与非对象行跳过并 warn，好行照常还原", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const log = captureLog();
  const store = createStore({ storageRoot: dir, log });
  const r1 = record(new Date(2026, 9, 2, 10, 0).getTime());
  store.append(r1);
  // 手工塞入坏行：半截写崩溃的 JSON 残迹 + 合法 JSON 但不是记录对象
  appendFileSync(join(dir, "records-2026-10.jsonl"), "not json\nnull\n", "utf8");

  assert.deepEqual(store.readAllRecords(), [r1]);
  assert.equal(log.calls.warn.length, 2);
  assert.match(log.calls.warn[0], /跳过/);
  assert.match(log.calls.warn[1], /跳过/);
});

test("store: 锁互斥——持有中再 acquire 抛错，close 后可重获", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const a = createStore({ storageRoot: dir, log: silent });
  const b = createStore({ storageRoot: dir, log: silent });
  a.acquireLock();
  assert.throws(() => b.acquireLock(), /锁/);
  a.close();
  b.acquireLock();
  b.close();
});

test("store: 陈旧锁（utimesSync 拨旧 mtime ≥5min）接管成功；锁内容含 pid", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const lockPath = join(dir, "lock");
  const a = createStore({ storageRoot: dir, log: silent });
  a.acquireLock();
  assert.match(readFileSync(lockPath, "utf8"), new RegExp(`"pid":${process.pid}`));

  const stale = new Date(Date.now() - 6 * 60 * 1000);
  utimesSync(lockPath, stale, stale);
  const b = createStore({ storageRoot: dir, log: silent });
  b.acquireLock(); // 接管不抛
  assert.match(readFileSync(lockPath, "utf8"), new RegExp(`"pid":${process.pid}`));
  // 此处不得再 a.close()：锁文件已归 b，a 再删会误伤接管者
  b.close();
  assert.equal(existsSync(lockPath), false);
});

test("store: writeDaily 原子写读回一致；listDailyDates 排序且过滤 tmp；坏缓存按 null 降级", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const log = captureLog();
  const store = createStore({ storageRoot: dir, log });

  assert.equal(store.readDaily("2026-10-03"), null); // 无缓存
  assert.equal(log.calls.warn.length, 0); // 文件不存在是常态，不算读失败

  const daily = { version: 1, date: "2026-10-03", byModel: {}, byHour: new Array(24).fill(0), sessions: {} };
  store.writeDaily("2026-10-03", daily);
  assert.deepEqual(store.readDaily("2026-10-03"), daily);
  store.writeDaily("2026-10-02", { version: 1, date: "2026-10-02" });
  assert.deepEqual(store.listDailyDates(), ["2026-10-02", "2026-10-03"]);

  store.writeDaily("2026-10-03", { version: 1, date: "2026-10-03", byModel: { "deepseek/deepseek-chat": { samples: 1 } } });
  assert.deepEqual(store.readDaily("2026-10-03").byModel, { "deepseek/deepseek-chat": { samples: 1 } }); // 覆盖写生效

  mkdirSync(join(dir, "daily"), { recursive: true });
  writeFileSync(join(dir, "daily", "2026-09-01.json.999.tmp"), "{}"); // 崩溃残留 tmp 不得进列表
  assert.deepEqual(store.listDailyDates(), ["2026-10-02", "2026-10-03"]);

  writeFileSync(join(dir, "daily", "2026-10-01.json"), "{oops");
  assert.equal(store.readDaily("2026-10-01"), null); // 坏缓存按无缓存降级
  assert.equal(log.calls.warn.length, 1); // 但必须留痕
});

test("store: hasAnyRecords 与回填游标读写", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  const store = createStore({ storageRoot: dir, log: silent });
  assert.equal(store.hasAnyRecords(), false); // 目录尚不存在
  assert.deepEqual(store.readAllRecords(), []); // 无记录读=空数组，不炸
  assert.equal(store.readBackfillMarker(), null);

  store.append(record(new Date(2026, 9, 3, 9, 0).getTime()));
  assert.equal(store.hasAnyRecords(), true);
  // v2 形状：read 给缺省 watermarks 补空对象；round-trip 保留 done 与 watermarks
  store.writeBackfillMarker({ done: ["sid-1"] });
  assert.deepEqual(store.readBackfillMarker(), { done: ["sid-1"], watermarks: {} });
  store.writeBackfillMarker({ done: ["sid-1", "sid-2"], watermarks: { "sid-2": 41 }, updatedAt: 7 });
  assert.deepEqual(store.readBackfillMarker(), { done: ["sid-1", "sid-2"], watermarks: { "sid-2": 41 }, updatedAt: 7 });
});

test("store: 写失败纪律——首条 warn 丢弃，连续第 10 条升 error，之后不再升级", { timeout: 5000 }, (t) => {
  const dir = makeRoot(t);
  // storageRoot 落在普通文件之下：mkdir 必失败，构造稳定的写失败路径
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  const log = captureLog();
  const store = createStore({ storageRoot: join(blocker, "usage"), log });

  for (let i = 0; i < 9; i += 1) store.append(record(new Date(2020, 0, 1).getTime()));
  assert.equal(log.calls.warn.length, 1); // 只有首条 warn，不刷屏
  assert.equal(log.calls.error.length, 0);

  store.append(record(new Date(2020, 0, 1).getTime())); // 第 10 条
  assert.equal(log.calls.error.length, 1); // 连续满 10 升 error
  assert.equal(log.calls.warn.length, 1);

  store.append(record(new Date(2020, 0, 1).getTime())); // 第 11 条：仍失败但不重复升级
  assert.equal(log.calls.error.length, 1);
  assert.equal(log.calls.warn.length, 1);
});
