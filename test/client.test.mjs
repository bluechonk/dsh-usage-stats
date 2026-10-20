// client.test.mjs —— lib/client.js 的 __pure 直测面（零 DOM、零 npm 依赖）。
//
// 物化手法：client.js 顶层就摸 window.__ModuleLoader__.load({id, factory})，factory
// 收一个 require 并从 "react" / "react/jsx-runtime" 拉桩。这里伪造最小宿主全局把
// factory 跑一遍，捕获返回的 module.exports，再从 __pure 取 20 个纯函数直调。
// 沙箱纪律：不碰任何生产文件，物化缺什么桩就补什么桩，client.js 一行不改。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// —— 最小 React 桩：只按 client.js 实际摸到的面给（Component/五个 hook/createElement）——
class StubComponent {}
const reactStub = {
  Component: StubComponent,
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  createElement: (t, p, ...c) => ({ t, p, c }),
};
const jsxStub = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const stubRequire = (id) => {
  if (id === "react") return reactStub;
  if (id === "react/jsx-runtime") return jsxStub;
  throw new Error("client.test 桩未覆盖的 require：" + id);
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => { captured = def.factory(stubRequire); },
  },
};
const mod = await import("../lib/client.js");
delete globalThis.window; // 顶层只摸一次 window，物化完即拆，免得泄漏给同进程后续动态 import
assert.ok(captured !== null && captured.__pure !== undefined, "桩物化失败：client.js 的 factory 未被宿主 load 调到");
const P = captured.__pure;

// —— 断言 __pure 的实际导出面（防导出漂移：多导/少导/解冻都算变化）——
const PURE_KEYS = [
  "fmtCompact", "fmtFull", "fmtDuration", "fmtStreak",
  "dateKey", "parseDateKey", "addDays", "fmtDayCn", "fmtFullDayCn",
  "hmLevel", "hmColumnsOf", "hmMonthLabelsOf", "hmRenderOf",
  "monotonePath", "paletteVar", "modelValueOf", "trendModelRowsOf",
  "donutRowsOf", "donutArcPath", "validOf",
  // v0.2.0 增量（SPEC §6）
  "phaseAfterTick", "summaryCellsOf", "tipPlacementOf", "tipRowsOf",
  "pctTextOf", "donutTipTextOf", "needHeatmapRefreshOf", "cursorStepOf", "backfillUiOf",
];
test("__pure 导出面快照（29 个纯函数、冻结）", { timeout: 5000 }, () => {
  assert.deepEqual(Object.keys(P).sort(), [...PURE_KEYS].sort());
  assert.ok(Object.isFrozen(P));
});

//#region monotonePath（单调三次插值）
/** 把 path 串按命令解析，对每个 C 段做三次贝塞尔采样取 Y 序列；顺手校验坐标全有限。 */
function samplePathYs(d, perSeg = 40) {
  assert.equal(typeof d, "string");
  assert.ok(!d.includes("NaN") && !d.includes("Infinity"), "path 坐标出现非有限数：" + d);
  const cmds = d.match(/[MC][^MC]+/g);
  assert.ok(cmds !== null && cmds.length > 0, "path 无可解析命令：" + d);
  const ys = [];
  let cur = null;
  for (const cmd of cmds) {
    const nums = (cmd.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (cmd[0] === "M") {
      assert.equal(nums.length, 2, "M 命令应为 1 对坐标：" + cmd);
      cur = [nums[0], nums[1]];
      ys.push(cur[1]);
    } else {
      assert.equal(nums.length, 6, "C 命令应为 3 对坐标：" + cmd);
      const c1 = nums[1], c2 = nums[3], p3 = nums[5], p0 = cur[1];
      for (let i = 1; i <= perSeg; i++) {
        const t = i / perSeg, u = 1 - t;
        ys.push(u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3);
      }
      cur = [nums[4], nums[5]];
    }
  }
  return ys;
}

test("monotonePath：强升+深谷点列，整条曲线 Y 采样不越过输入值域（无过冲）", { timeout: 5000 }, () => {
  const pts = [[0, 100], [60, 120], [120, 140], [180, 20], [240, 200], [300, 220]];
  const ys = samplePathYs(P.monotonePath(pts));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  assert.ok(ys.length >= pts.length);
  assert.ok(Math.min(...ys) >= minY, "曲线向下越过输入 Y 下界 " + minY + "，实测 " + Math.min(...ys));
  assert.ok(Math.max(...ys) <= maxY, "曲线向上越过输入 Y 上界 " + maxY + "，实测 " + Math.max(...ys));
});

test("monotonePath：纯单调上升点列同样不过冲", { timeout: 5000 }, () => {
  const pts = [[0, 0], [100, 50], [200, 120], [300, 300]];
  const ys = samplePathYs(P.monotonePath(pts));
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 300);
});

test("monotonePath：单点返回空串，两点退化为直线段", { timeout: 5000 }, () => {
  assert.equal(P.monotonePath([[1, 2]]), "");
  assert.equal(P.monotonePath([[0, 0], [10, 10]]), "M0,0 L10,10");
  assert.equal(P.monotonePath([]), "");
});

test("monotonePath：重复 x 防 NaN（v0.2.0 §6：dx<=0 段置 s=0，路径全有限）", { timeout: 5000 }, () => {
  let out;
  assert.doesNotThrow(() => { out = P.monotonePath([[5, 10], [5, 20], [8, 30]]); });
  assert.equal(typeof out, "string");
  assert.ok(!out.includes("NaN") && !out.includes("Infinity"), "重复横坐标仍在污染路径：" + out);
  samplePathYs(out); // 内部断言每个坐标都是有限数
  const flat = P.monotonePath([[5, 10], [5, 20], [5, 30], [5, 40]]); // 全重复横坐标
  assert.ok(!flat.includes("NaN") && !flat.includes("Infinity"));
  // 精确断言：dx<=0 段确按 s=0（平段）处理——只查「无 NaN」抓不住把守卫换成其它有限值
  // （s=1 同样无 NaN 但会把重复 x 段的控制点拉歪：首段控制点变 8.0,20.0 8.0,30.0）
  assert.equal(P.monotonePath([[5, 10], [5, 20], [8, 30]]), "M5,10C5.0,10.0 5.0,20.0 5.0,20.0C6.0,20.0 7.0,26.7 8.0,30.0");
  // 回归：修复只影响 dx<=0 分支，严格递增的数据输出逐字不变
  assert.equal(P.monotonePath([[0, 0], [10, 10]]), "M0,0 L10,10");
  assert.equal(P.monotonePath([[1, 2]]), "");
});
//#endregion

//#region 热力图（hmColumnsOf / hmMonthLabelsOf / hmRenderOf / hmLevel）
test("hmColumnsOf：固定 52 列 × 每列 7 格，列首全部周日起始、列内逐日递增", { timeout: 5000 }, () => {
  const cols = P.hmColumnsOf([]);
  assert.equal(cols.length, 52);
  for (const col of cols) {
    assert.equal(col.length, 7);
    assert.equal(col[0].date.getDay(), 0); // 周日对齐（getDay 0=周日）
  }
  for (let k = 0; k < 7; k++) assert.equal(P.dateKey(cols[0][k].date), P.dateKey(P.addDays(cols[0][0].date, k)));
});

test("hmColumnsOf：末列含今天（末周对齐当前周）", { timeout: 5000 }, () => {
  const cols = P.hmColumnsOf([]);
  const todayKey = P.dateKey(new Date());
  assert.ok(cols[51].some((c) => P.dateKey(c.date) === todayKey));
});

test("hmColumnsOf：API 逐日数组按 dateKey 对号入座，缺失日 tokens/turns=0 且 rec=false", { timeout: 5000 }, () => {
  const todayKey = P.dateKey(new Date());
  const yKey = P.dateKey(P.addDays(new Date(), -1));
  const cols = P.hmColumnsOf([{ date: todayKey, tokens: 100, turns: 4 }]);
  const hit = cols.flat().find((c) => P.dateKey(c.date) === todayKey);
  assert.deepEqual({ rec: hit.rec, tokens: hit.tokens, turns: hit.turns }, { rec: true, tokens: 100, turns: 4 });
  const miss = cols.flat().find((c) => P.dateKey(c.date) === yKey);
  assert.equal(miss.rec, false);
  assert.equal(miss.tokens, 0);
  assert.equal(miss.turns, 0);
});

test("hmColumnsOf：坏记录逐条跳过、非数组输入也返回 52 列", { timeout: 5000 }, () => {
  for (const bad of [null, 42, {}, { date: 7 }, ["x"], { date: "not-a-date-key", tokens: 99 }]) {
    const cols = P.hmColumnsOf([bad]);
    assert.equal(cols.length, 52);
    assert.equal(cols[0].length, 7);
    assert.ok(cols.flat().every((c) => c.rec === false || typeof c === "object"));
  }
  assert.equal(P.hmColumnsOf(null).length, 52);
  assert.equal(P.hmColumnsOf(undefined).length, 52);
});

/** 手工造列（n 格、第 recAt 格标 rec），供月份标签锚点测试用，与今天无关。 */
function mkCol(y, mo, d, n = 7, recAt = -1) {
  return Array.from({ length: n }, (_, i) => ({ date: new Date(y, mo - 1, d + i), rec: i === recAt, tokens: 0, turns: 0 }));
}

test("hmMonthLabelsOf：锚点优先级=周内首个 1 号 > 首个有记录日 > 周日；相邻同月并 span", { timeout: 5000 }, () => {
  const cols = [
    mkCol(2026, 3, 28),        // 2026-03-28..04-03：含 4 月 1 号 → 锚 2026-04
    mkCol(2026, 4, 4, 7, 2),   // 无 1 号、04-06 有记录 → 锚 2026-04
    mkCol(2026, 4, 11),        // 无 1 号、无记录 → 锚 col[0]=2026-04-11 → 2026-04
    mkCol(2026, 5, 1, 1),      // 2026-05-01 → 新键 2026-05
  ];
  assert.deepEqual(P.hmMonthLabelsOf(cols), [
    { key: "2026-04", label: "4月", span: 3 },
    { key: "2026-05", label: "5月", span: 1 },
  ]);
});

test("hmMonthLabelsOf：超 12 个月从头置空标签；不足 12 个月全保留", { timeout: 5000 }, () => {
  const m13 = Array.from({ length: 13 }, (_, i) => mkCol(2025 + Math.floor((i) / 12), (i % 12) + 1, 15, 1));
  const l13 = P.hmMonthLabelsOf(m13);
  assert.equal(l13.length, 13);
  assert.equal(l13[0].label, "");
  assert.ok(l13.slice(1).every((l) => l.label !== ""));
  assert.equal(l13[12].label, "1月"); // 2026-01 → 数字月拼「1月」
  const m12 = m13.slice(1);
  const l12 = P.hmMonthLabelsOf(m12);
  assert.equal(l12.length, 12);
  assert.ok(l12.every((l) => l.label !== ""));
});

test("hmMonthLabelsOf：真实 52 列——span 总和守恒=52、月键合法、置空规则与月数自洽", { timeout: 5000 }, () => {
  const labels = P.hmMonthLabelsOf(P.hmColumnsOf([]));
  assert.equal(labels.reduce((a, l) => a + l.span, 0), 52);
  assert.ok(labels.length >= 12 && labels.length <= 13);
  const hidden = Math.max(0, labels.length - 12);
  labels.forEach((l, i) => {
    assert.match(l.key, /^\d{4}-\d{2}$/);
    assert.equal(l.label === "", i < hidden);
    if (l.label !== "") assert.equal(l.label, Number(l.key.slice(5, 7)) + "月");
  });
});

test("hmRenderOf daily：52 行 × 7 格，今天=满档有 tooltip，缺勤日=0 档无 tooltip", { timeout: 5000 }, () => {
  const todayKey = P.dateKey(new Date());
  const cols = P.hmColumnsOf([{ date: todayKey, tokens: 100, turns: 4 }]);
  const rd = P.hmRenderOf(cols, "daily");
  assert.equal(rd.length, 52);
  assert.ok(rd.every((r) => r.cells.length === 7));
  const ti = cols[51].findIndex((c) => P.dateKey(c.date) === todayKey);
  const tc = rd[51].cells[ti];
  assert.equal(tc.has, true);
  assert.equal(tc.lvl, 4); // dayMax=100 → v/max*4=4，顶档
  const d = cols[51][ti].date;
  assert.equal(tc.title, d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日\n100 tokens · 4 轮消息");
  const yKey = P.dateKey(P.addDays(new Date(), -1));
  let yc = null;
  for (let w = 0; w < 52 && yc === null; w++)
    for (let i = 0; i < 7; i++)
      if (P.dateKey(cols[w][i].date) === yKey) yc = rd[w].cells[i];
  assert.ok(yc !== null);
  assert.equal(yc.has, false);
  assert.equal(yc.lvl, 0);
  assert.equal(yc.title, "");
});

test("hmRenderOf weekly/total：列值=colMax 时 7 格底对齐满柱，零值列全灭；整列 tooltip 锚末列日", { timeout: 5000 }, () => {
  const todayKey = P.dateKey(new Date());
  const cols = P.hmColumnsOf([{ date: todayKey, tokens: 100, turns: 4 }]);
  const rw = P.hmRenderOf(cols, "weekly");
  const last = cols[51][6].date;
  const tail = "\n100 tokens · 4 轮消息";
  assert.equal(rw[51].title, last.getFullYear() + "年" + (last.getMonth() + 1) + "月" + last.getDate() + "日" + tail);
  assert.deepEqual(rw[51].cells.map((c) => c.lvl), [4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual(rw[51].cells.map((c) => c.has), [true, true, true, true, true, true, true]);
  assert.ok(rw[0].title.endsWith("\n0 tokens · 0 轮消息"));
  assert.deepEqual(rw[0].cells.map((c) => c.lvl + ":" + c.has), ["0:false", "0:false", "0:false", "0:false", "0:false", "0:false", "0:false"]);
  const rt = P.hmRenderOf(cols, "total");
  assert.deepEqual(rt[51].cells.map((c) => c.lvl), [4, 4, 4, 4, 4, 4, 4]); // 累计末列=全程 colMax
  assert.deepEqual(rt[0].cells.map((c) => c.lvl), [0, 0, 0, 0, 0, 0, 0]);
  assert.ok(rt[51].title.endsWith(tail));
});

test("hmRenderOf 累计档：轮数走累计口径，不与周轮数混口径（目检发现）", { timeout: 5000 }, () => {
  // 两周各 3/5 轮：累计档第二列应报 8 轮（前一周 3 + 本周 5），周档仍只报本周 5 轮
  const cols = P.hmColumnsOf([]);
  const d1 = P.dateKey(cols[49][2].date); // 前推两周内的某天
  const d2 = P.dateKey(cols[51][2].date); // 本周内的某天
  const filled = P.hmColumnsOf([{ date: d1, tokens: 10, turns: 3 }, { date: d2, tokens: 20, turns: 5 }]);
  // hmColumnsOf 内部按「今天」重算 52 列：直接复用同一批列做 render 才有稳定索引
  const rw = P.hmRenderOf(filled, "weekly");
  const rt = P.hmRenderOf(filled, "total");
  assert.ok(rw[51].title.endsWith("20 tokens · 5 轮消息"), rw[51].title);
  assert.ok(rt[51].title.endsWith("30 tokens · 8 轮消息"), rt[51].title);
  assert.ok(rt[49].title.endsWith("10 tokens · 3 轮消息"), rt[49].title);
});

test("hmLevel：零值/坏 max=0 档，其余 ceil(v/max*4) 钳 [1,4]", { timeout: 5000 }, () => {
  assert.equal(P.hmLevel(0, 100), 0);
  assert.equal(P.hmLevel(-1, 100), 0);
  assert.equal(P.hmLevel(10, 0), 0);
  assert.equal(P.hmLevel(10, -5), 0);
  assert.equal(P.hmLevel(1, 100), 1);
  assert.equal(P.hmLevel(13, 100), 1);
  assert.equal(P.hmLevel(26, 100), 2);
  assert.equal(P.hmLevel(50, 100), 2);
  assert.equal(P.hmLevel(90, 100), 4);
  assert.equal(P.hmLevel(100, 100), 4);
  assert.equal(P.hmLevel(500, 100), 4); // 超 max 也钳 4
});
//#endregion

//#region 环形图（donutRowsOf / donutArcPath）
test("donutRowsOf：8 模型归并 6 行+「其他模型」，行额与 total 守恒=正额总和", { timeout: 5000 }, () => {
  const models8 = Array.from({ length: 8 }, (_, i) => ({ key: "m" + i, tokens: (i + 1) * 1000 }));
  const out = P.donutRowsOf({ models: models8 });
  assert.equal(out.rows.length, 7);
  assert.equal(out.rows[6].key, "其他模型");
  assert.equal(out.rows[6].color, "var(--dus-fgfaint)");
  assert.equal(out.rows[6].tokens, 3000); // m0+m1 被 slice(6) 截进「其他」
  assert.deepEqual(out.rows.slice(0, 6).map((r) => r.key), ["m7", "m6", "m5", "m4", "m3", "m2"]); // 按额降序
  assert.deepEqual(out.rows.slice(0, 6).map((r) => r.color), ["var(--dus-c1)", "var(--dus-c2)", "var(--dus-c3)", "var(--dus-c4)", "var(--dus-c5)", "var(--dus-c6)"]);
  assert.equal(out.total, 36000);
  assert.equal(out.rows.reduce((a, r) => a + r.tokens, 0), out.total);
});

test("donutRowsOf：全零/负输入 → 空 rows + total=0（负残值不进图）", { timeout: 5000 }, () => {
  const out = P.donutRowsOf({ models: [{ key: "a", tokens: 0 }, { key: "b", tokens: -9 }] });
  assert.deepEqual(out, { rows: [], total: 0 });
});

test("donutRowsOf：坏形状（无 models 数组）显式返回 null，不静默当空数据", { timeout: 5000 }, () => {
  assert.equal(P.donutRowsOf({}), null);
  assert.equal(P.donutRowsOf(null), null);
  assert.equal(P.donutRowsOf({ models: "x" }), null);
});

test("donutRowsOf：只读 models 响应——模型用量恒为全期口径，不按时间范围过滤", { timeout: 5000 }, () => {
  // /models?days=0 返回的就是全量，client 不再按 range 二次过滤
  const out = P.donutRowsOf({ models: [{ key: "x/a", tokens: 130 }, { key: "x/b", tokens: 50 }] });
  assert.deepEqual(out.rows.map((r) => [r.key, r.tokens]), [["x/a", 130], ["x/b", 50]]);
  assert.equal(out.total, 180);
});

test("donutArcPath：整圆/零角度/>360° 都不产出非法路径（无 NaN/Infinity，M…Z 结构完整）", { timeout: 5000 }, () => {
  for (const [a0, a1] of [[0, 360], [30, 30], [0, 400]]) {
    const d = P.donutArcPath(100, 100, 76, 50.4, a0, a1);
    assert.equal(typeof d, "string");
    assert.ok(d.startsWith("M") && d.endsWith("Z"));
    assert.ok(!d.includes("NaN") && !d.includes("Infinity"));
    for (const n of d.match(/-?\d+(?:\.\d+)?/g)) assert.ok(Number.isFinite(Number(n)));
    assert.ok(d.includes("A76,76"), "外弧半径应原样拼接");
    assert.ok(d.includes("A50.4,50.4"), "内弧半径应原样拼接");
  }
  // 设计值整圆精确断言：large=1，起终点重合在 (cx+rO, cy)
  assert.equal(
    P.donutArcPath(100, 100, 76, 50.4, 0, 360),
    "M176.00,100.00 A76,76 0 1 1 176.00,100.00 L150.40,100.00 A50.4,50.4 0 1 0 150.40,100.00 Z",
  );
  // 零角度 large=0；>360° 不钳制但 cos/sin 周期回绕，端点仍有限
  assert.equal(P.donutArcPath(100, 100, 76, 50.4, 30, 30).slice(0, 4), "M165");
  assert.ok(P.donutArcPath(100, 100, 76, 50.4, 0, 400).includes(" 0 1 1 "));
});
//#endregion

//#region 格式化（fmtCompact / fmtFull / fmtDuration / fmtStreak）
test("fmtCompact：各档位精确断言（含万→亿的分档边界）", { timeout: 5000 }, () => {
  assert.equal(P.fmtCompact(0), "0");
  assert.equal(P.fmtCompact(-5), "0");
  assert.equal(P.fmtCompact(NaN), "0");
  assert.equal(P.fmtCompact(Infinity), "0");
  assert.equal(P.fmtCompact(999.6), "1000"); // <1e4 走整数四舍五入
  assert.equal(P.fmtCompact(9999), "9999");
  assert.equal(P.fmtCompact(10000), "1 万");
  assert.equal(P.fmtCompact(12345), "1.2 万");
  // v0.2.0 口径变更（SPEC §6）：万档四舍五入后 ≥10000 时改走亿档——
  // 旧口径显示「10000 万」（数值等价但别扭），新口径「1 亿」。这条断言随需求改口径。
  assert.equal(P.fmtCompact(99999999), "1 亿");
  assert.equal(P.fmtCompact(99999500), "1 亿"); // 万档进位阈值：9999.95 万 → 1 亿
  assert.equal(P.fmtCompact(99994999), "9999.5 万"); // 未进位仍在万档
  assert.equal(P.fmtCompact(1e8), "1 亿");
  assert.equal(P.fmtCompact(2.5e8), "2.5 亿");
});

test("fmtCompact：tight=true 无空格、缺省带空格，两口径并存", { timeout: 5000 }, () => {
  assert.equal(P.fmtCompact(12345, true), "1.2万");
  assert.equal(P.fmtCompact(12345), "1.2 万");
  assert.equal(P.fmtCompact(1e8, true), "1亿");
  assert.equal(P.fmtCompact(1e8), "1 亿");
  assert.equal(P.fmtCompact(10000, true), "1万");
  assert.equal(P.fmtCompact(99999999, true), "1亿"); // 亿档转换同样遵守 tight 口径
});

test("fmtFull：千分位完整数字；坏输入按 0", { timeout: 5000 }, () => {
  assert.equal(P.fmtFull(1234567), "1,234,567");
  assert.equal(P.fmtFull(1000), "1,000");
  assert.equal(P.fmtFull(999), "999");
  assert.equal(P.fmtFull(-1234), "-1,234");
  assert.equal(P.fmtFull(0), "0");
  assert.equal(P.fmtFull("abc"), "0");
  assert.equal(P.fmtFull(123.4), "123"); // 先 round 再插逗号
});

test("fmtDuration：天/小时分钟/分钟三档；非正与亚分钟=「0 分钟」", { timeout: 5000 }, () => {
  assert.equal(P.fmtDuration(0), "0 分钟");
  assert.equal(P.fmtDuration(-5), "0 分钟");
  assert.equal(P.fmtDuration(NaN), "0 分钟");
  assert.equal(P.fmtDuration(30 * 1000), "0 分钟");
  assert.equal(P.fmtDuration(5 * 60000), "5 分钟");
  assert.equal(P.fmtDuration(2 * 3600000 + 5 * 60000), "2 小时 5 分");
  assert.equal(P.fmtDuration(3 * 86400000), "3 天");
  assert.equal(P.fmtDuration(86400000 + 1), "1 天"); // ≥1 天只报天，不拼时分
});

test("fmtStreak：数字直拼「n 天」，空值兜「0 天」", { timeout: 5000 }, () => {
  assert.equal(P.fmtStreak(7), "7 天");
  assert.equal(P.fmtStreak(0), "0 天");
  assert.equal(P.fmtStreak(undefined), "0 天");
});
//#endregion

//#region 日期（dateKey / parseDateKey / addDays / 中文日）
test("dateKey ↔ parseDateKey 往返守恒；单位数宽松解析归一；非法输入显式 null", { timeout: 5000 }, () => {
  assert.equal(P.dateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(P.dateKey(new Date(2026, 10, 26)), "2026-11-26");
  for (const k of ["2025-12-31", "2026-02-28", "2024-02-29", "2026-01-01", "2026-10-06"]) {
    const d = P.parseDateKey(k);
    assert.ok(d !== null);
    assert.equal(d.getFullYear(), Number(k.slice(0, 4)));
    assert.equal(d.getMonth() + 1, Number(k.slice(5, 7)));
    assert.equal(d.getDate(), Number(k.slice(8, 10)));
    assert.equal(P.dateKey(d), k);
  }
  const loose = P.parseDateKey("2026-1-5"); // 单位数收进来，往返归一补零
  assert.equal(P.dateKey(loose), "2026-01-05");
  assert.equal(P.parseDateKey(123), null);
  assert.equal(P.parseDateKey(null), null);
  assert.equal(P.parseDateKey("2026/01/05"), null);
  assert.equal(P.parseDateKey("garbage"), null);
});

test("addDays：跨月/跨年/闰年走 setDate 不漂移，且不改原对象", { timeout: 5000 }, () => {
  assert.equal(P.dateKey(P.addDays(new Date(2026, 0, 31), 1)), "2026-02-01");
  assert.equal(P.dateKey(P.addDays(new Date(2025, 11, 31), 1)), "2026-01-01");
  assert.equal(P.dateKey(P.addDays(new Date(2026, 2, 1), -1)), "2026-02-28"); // 2026 非闰年
  assert.equal(P.dateKey(P.addDays(new Date(2026, 0, 1), -1)), "2025-12-31");
  assert.equal(P.dateKey(P.addDays(new Date(2024, 1, 28), 1)), "2024-02-29"); // 2024 闰年
  const orig = new Date(2026, 0, 1);
  const moved = P.addDays(orig, 5);
  assert.equal(P.dateKey(orig), "2026-01-01");
  assert.equal(P.dateKey(moved), "2026-01-06");
  assert.ok(moved instanceof Date);
});

test("fmtDayCn / fmtFullDayCn：中文月日拼接（月日不带前导零）", { timeout: 5000 }, () => {
  assert.equal(P.fmtDayCn(new Date(2026, 9, 6)), "10月6日");
  assert.equal(P.fmtFullDayCn(new Date(2026, 9, 6)), "2026年10月6日");
  assert.equal(P.fmtDayCn(new Date(2026, 0, 5)), "1月5日");
});
//#endregion

//#region 模型行（paletteVar / modelValueOf / trendModelRowsOf）
test("paletteVar：6 色循环取用，负索引同余回绕", { timeout: 5000 }, () => {
  assert.equal(P.paletteVar(0), "var(--dus-c1)");
  assert.equal(P.paletteVar(5), "var(--dus-c6)");
  assert.equal(P.paletteVar(6), "var(--dus-c1)");
  assert.equal(P.paletteVar(-1), "var(--dus-c6)");
  assert.equal(P.paletteVar(13), "var(--dus-c2)");
});

test("modelValueOf：正常读取；缺键/坏值/缺 byModel/null 点全兜 0；有限负值保留", { timeout: 5000 }, () => {
  assert.equal(P.modelValueOf({ byModel: { a: 5, b: "x" } }, "a"), 5);
  assert.equal(P.modelValueOf({ byModel: { a: 5 } }, "zz"), 0);
  assert.equal(P.modelValueOf({ byModel: { a: "oops" } }, "a"), 0);
  assert.equal(P.modelValueOf({}, "a"), 0);
  assert.equal(P.modelValueOf(null, "a"), 0);
  assert.equal(P.modelValueOf({ byModel: null }, "a"), 0);
  assert.equal(P.modelValueOf({ byModel: { a: -2.5 } }, "a"), -2.5); // 负增量过滤是调用方的事
});

test("trendModelRowsOf：跨点并集、按总量降序、零/负总量滤除；空与坏输入=空表", { timeout: 5000 }, () => {
  assert.deepEqual(P.trendModelRowsOf([{ byModel: { "m/a": 10, "m/b": 30 } }, { byModel: { "m/a": 5, "m/c": 0 } }, null, { bad: 1 }]), [
    { key: "m/b", color: "var(--dus-c1)" },
    { key: "m/a", color: "var(--dus-c2)" },
  ]);
  assert.deepEqual(P.trendModelRowsOf([]), []);
  assert.deepEqual(P.trendModelRowsOf(null), []);
  assert.deepEqual(P.trendModelRowsOf([{ byModel: { "m/z": -5 } }]), []);
});
//#endregion

//#region 形状哨兵 validOf
test("validOf：summary/heatmap/trend/models 四路合法样例全过", { timeout: 5000 }, () => {
  assert.equal(P.validOf("summary", { totalTokens: 5 }), true);
  assert.equal(P.validOf("summary", { totalTokens: "5123" }), true); // 数值串按 Number 收
  assert.equal(P.validOf("heatmap", { days: [] }), true);
  assert.equal(P.validOf("trend", { points: [] }), true);
  assert.equal(P.validOf("models", { models: [] }), true);
});

test("validOf：缺字段/错类型/非对象/未知键显式不过", { timeout: 5000 }, () => {
  assert.equal(P.validOf("summary", {}), false);
  assert.equal(P.validOf("summary", { totalTokens: NaN }), false);
  assert.equal(P.validOf("summary", { totalTokens: "abc" }), false);
  assert.equal(P.validOf("summary", null), false);
  assert.equal(P.validOf("summary", 42), false);
  assert.equal(P.validOf("heatmap", {}), false);
  assert.equal(P.validOf("heatmap", { days: "x" }), false);
  assert.equal(P.validOf("heatmap", { days: null }), false);
  assert.equal(P.validOf("trend", {}), false);
  assert.equal(P.validOf("trend", { points: {} }), false);
  assert.equal(P.validOf("models", {}), false);
  assert.equal(P.validOf("models", { models: 3 }), false);
  assert.equal(P.validOf("whatever", { a: 1 }), false);
});
//#endregion

//#region v0.2.0 增量（SPEC §6）——phase 转移 / 摘要格 / 卡片定位 / 文案映射 / 游标
test("phaseAfterTick：full 拍全权，静默拍单调（ready 恒保持、非 ready 只升 ready、其余 no-op）", { timeout: 5000 }, () => {
  // full（silent=false/falsey）：任何转移都放行——用户发起或初始 load 说是什么就是什么
  for (const prev of ["loading", "ready", "empty", "error"]) {
    for (const next of ["loading", "ready", "empty", "error"]) {
      assert.equal(P.phaseAfterTick(prev, next, false), next, prev + "→" + next);
      assert.equal(P.phaseAfterTick(prev, next, undefined), next, prev + "→" + next);
    }
  }
  // 静默拍：已就绪的面板绝不被打回空态/错误态/加载态（一次网络抖动不允许清空有数据的面板）
  assert.equal(P.phaseAfterTick("ready", "empty", true), "ready");
  assert.equal(P.phaseAfterTick("ready", "error", true), "ready");
  assert.equal(P.phaseAfterTick("ready", "loading", true), "ready");
  assert.equal(P.phaseAfterTick("ready", "ready", true), "ready");
  // 静默拍允许**升级**：空态/错误态/加载态 → 就绪（治「空态没有自愈出路」）
  assert.equal(P.phaseAfterTick("empty", "ready", true), "ready");
  assert.equal(P.phaseAfterTick("error", "ready", true), "ready");
  assert.equal(P.phaseAfterTick("loading", "ready", true), "ready");
  // 其余 no-op：空/错/加载之间互不串门
  assert.equal(P.phaseAfterTick("empty", "error", true), "empty");
  assert.equal(P.phaseAfterTick("empty", "loading", true), "empty");
  assert.equal(P.phaseAfterTick("error", "empty", true), "error");
  assert.equal(P.phaseAfterTick("loading", "empty", true), "loading");
  assert.equal(P.phaseAfterTick("loading", "error", true), "loading");
});

test("summaryCellsOf：六格值/标签逐字；悬停带精确值、峰值日期、累计起点与口径说明", { timeout: 5000 }, () => {
  const cells = P.summaryCellsOf({
    since: "2026-09-01", totalTokens: 4580000, peakDay: { date: "2026-10-03", tokens: 1234567 },
    longestChatMs: 2 * 3600000 + 5 * 60000, currentStreakDays: 7, longestStreakDays: 12,
    cacheReadTokens: 3000000, uncachedInputTokens: 1000000, cacheHitRate: 75,
  });
  assert.deepEqual(cells.map((c) => c.key), ["total", "peak", "cache", "longest", "cur", "max"]);
  assert.deepEqual(cells.map((c) => c.value), ["458 万", "123.5 万", "75.0%", "2 小时 5 分", "7 天", "12 天"]);
  assert.deepEqual(cells.map((c) => c.label), ["累计 Token 数", "峰值 Token 数", "缓存命中率", "最长聊天时长", "当前连续天数", "最长连续天数"]);
  assert.equal(cells[0].title, "累计 4,580,000 Token，自 2026-09-01 起");
  assert.equal(cells[1].title, "单日峰值 1,234,567 Token（10月3日）");
  assert.equal(cells[2].title, "缓存命中 3,000,000 Token / 输入合计 4,000,000 Token");
  assert.equal(cells[3].title, "按（会话, 日）分桶取最长一次，跨日会话按日截断");
  assert.equal(cells[4].title, "每天有用量算一天；今天还没有用量时从昨天往回数");
  assert.equal(cells[5].title, "历史最长的连续有用量天数");
});

test("summaryCellsOf：空数据/坏输入不炸——全零、无起点、峰值「暂无用量」", { timeout: 5000 }, () => {
  const empty = P.summaryCellsOf({ since: "2026-10-13", totalTokens: 0, peakDay: null, longestChatMs: 0, currentStreakDays: 0, longestStreakDays: 0 });
  assert.deepEqual(empty.map((c) => c.value), ["0", "0", "—", "0 分钟", "0 天", "0 天"]);
  assert.equal(empty[0].title, "累计 0 Token，自 2026-10-13 起");
  assert.equal(empty[1].title, "暂无用量");
  assert.equal(empty[2].title, "暂无输入用量，无法计算缓存命中率");
  const bad = P.summaryCellsOf(null);
  assert.equal(bad.length, 6);
  assert.equal(bad[0].value, "0");
  assert.equal(bad[0].title, "累计 0 Token"); // 无 since 时不拼「自…起」
  assert.equal(bad[1].title, "暂无用量");
  assert.equal(bad[2].value, "—"); // 无命中率字段时显示破折号，不是 0%
  // 峰值无日期（畸形）同样走「暂无用量」
  assert.equal(P.summaryCellsOf({ totalTokens: 5, peakDay: { tokens: 9 } })[1].title, "暂无用量");
});

test("tipPlacementOf：锚点右侧优先、右侧放不下翻到左侧、两轴钳位不出容器", { timeout: 5000 }, () => {
  // 宽容器 + 中间锚点：卡在锚点右侧
  assert.deepEqual(P.tipPlacementOf(300, 120, 800, 240, 230, 120), { left: 314, top: 60 });
  // 靠右边缘：翻到锚点左侧，右边界不出容器
  const right = P.tipPlacementOf(790, 120, 800, 240, 230, 120);
  assert.equal(right.left, 546); // 790-14-230
  assert.ok(right.left + 230 <= 800 - 8);
  // 靠左边缘：仍挂在锚点右侧（+14 间隙后仍在左边距之内，无需钳位）
  assert.equal(P.tipPlacementOf(2, 120, 800, 240, 230, 120).left, 16);
  // 真正需要左钳位：锚点离左边距不足一个间隙时（此处 ax=-50 → 原始 left=-36 → 钳到 8）
  assert.equal(P.tipPlacementOf(-50, 120, 800, 240, 230, 120).left, 8);
  // 容器比卡片还窄：左钳到 margin（卡片由 CSS max-width 收进容器，宽度假设保守）
  const tiny = P.tipPlacementOf(50, 20, 200, 100, 230, 120);
  assert.equal(tiny.left, 8);
  assert.equal(tiny.top, 8);
  // 纵向钳位：锚点贴底时卡片不越下界
  const bottom = P.tipPlacementOf(300, 239, 800, 240, 230, 120);
  assert.equal(bottom.top, 112); // 240-120-8
  // 坏输入不产 NaN
  const bad = P.tipPlacementOf(undefined, null, 0, 0, 0, 0);
  assert.ok(Number.isFinite(bad.left) && Number.isFinite(bad.top));
  // 分侧按**右边距**判（792=800-8），不是容器边：ax=552 右侧候选 566+230=796 越过边距 → 翻左 308；
  // ax=548 时 562+230=792 恰贴边 → 不翻，右侧钳到 562。两侧一起精确断言阈值边界。
  assert.equal(P.tipPlacementOf(552, 120, 800, 240, 230, 120).left, 308);
  assert.equal(P.tipPlacementOf(548, 120, 800, 240, 230, 120).left, 562);
  // 不变量：宽容器（800 ≥ 230 + 两侧边距）下卡片四边都钳进容器——
  // 只查 left>=8 会恒真，漏掉「右侧上限钳位被去掉」（去掉后 left 仍 ≥8 却右溢出）。
  for (const ax of [-100, 0, 5, 200, 500, 795, 900]) {
    for (const ay of [-50, 0, 60, 200, 240, 500]) {
      const pos = P.tipPlacementOf(ax, ay, 800, 240, 230, 120);
      assert.ok(pos.left >= 8 && pos.left + 230 <= 800 - 8, "左/右越界：锚点 " + ax + "," + ay + " → " + JSON.stringify(pos));
      assert.ok(pos.top >= 8 && pos.top + 120 <= 240 - 8, "上/下越界：锚点 " + ax + "," + ay + " → " + JSON.stringify(pos));
    }
  }
});

test("tipRowsOf：0/负/缺值模型行不进卡片；值走万/亿简写；非数组输入空表", { timeout: 5000 }, () => {
  const rows = [{ key: "a", color: "c1" }, { key: "b", color: "c2" }, { key: "c", color: "c3" }];
  const out = P.tipRowsOf({ byModel: { a: 1234567, b: 0, c: -9 } }, rows);
  assert.deepEqual(out, [{ key: "a", color: "c1", value: "123.5万" }]);
  assert.deepEqual(P.tipRowsOf(null, rows), []);
  assert.deepEqual(P.tipRowsOf({ byModel: { a: 1 } }, null), []);
  assert.deepEqual(P.tipRowsOf({ byModel: { a: 5 } }, [{ key: "z", color: "c" }]), []); // 键不存在
});

test("pctTextOf：≥10% 取整、<10% 一位小数、零值/无效一律 0%", { timeout: 5000 }, () => {
  assert.equal(P.pctTextOf(6340, 10000), "63%");
  assert.equal(P.pctTextOf(1040, 10000), "10%");
  assert.equal(P.pctTextOf(114, 10000), "1.1%");
  assert.equal(P.pctTextOf(0, 10000), "0%");
  assert.equal(P.pctTextOf(-5, 10000), "0%");
  assert.equal(P.pctTextOf(5, 0), "0%");
  assert.equal(P.pctTextOf(5, -1), "0%");
  assert.equal(P.pctTextOf(NaN, 10), "0%");
});

test("donutTipTextOf：token 简写 + 占比一行", { timeout: 5000 }, () => {
  assert.equal(P.donutTipTextOf({ key: "x", tokens: 1234 }, 2000), "1234 Token · 62%"); // 61.7% ≥10 → 取整
  assert.equal(P.donutTipTextOf({ key: "x", tokens: 114 }, 10000), "114 Token · 1.1%");
  assert.equal(P.donutTipTextOf({ key: "x", tokens: 410000000 }, 1000000000), "4.1亿 Token · 41%");
  assert.equal(P.donutTipTextOf({ tokens: -5 }, 100), "0 Token · 0%");
  assert.equal(P.donutTipTextOf(null, 100), "0 Token · 0%");
});

test("needHeatmapRefreshOf：总量变、跨天才是 true；缺数据一律 false（不白发请求）", { timeout: 5000 }, () => {
  const a = { totalTokens: 100, today: "2026-10-13" };
  assert.equal(P.needHeatmapRefreshOf(a, { totalTokens: 100, today: "2026-10-13" }), false);
  assert.equal(P.needHeatmapRefreshOf(a, { totalTokens: 101, today: "2026-10-13" }), true);
  assert.equal(P.needHeatmapRefreshOf(a, { totalTokens: 100, today: "2026-10-14" }), true); // 跨天必须刷
  assert.equal(P.needHeatmapRefreshOf(a, { totalTokens: 0, today: "2026-10-13" }), true);  // 清库也要刷
  assert.equal(P.needHeatmapRefreshOf(null, a), false);
  assert.equal(P.needHeatmapRefreshOf(a, null), false);
  assert.equal(P.needHeatmapRefreshOf(undefined, undefined), false);
  // 数值串归一：'100' 与 100 视为未变（避免类型抖动引发无谓请求）
  assert.equal(P.needHeatmapRefreshOf({ totalTokens: "100", today: "x" }, { totalTokens: 100, today: "x" }), false);
  // today 缺失与 null 归一为同值（实现显式 undefined→null）：不因「缺字段 vs null」多刷一次
  assert.equal(P.needHeatmapRefreshOf({ totalTokens: 100 }, { totalTokens: 100, today: null }), false);
  assert.equal(P.needHeatmapRefreshOf({ totalTokens: 100, today: null }, { totalTokens: 100 }), false);
});

test("cursorStepOf：← → 走 stride、↑ ↓ 走 1、Home/End 到两端、越界钳位、非法键不动", { timeout: 5000 }, () => {
  // 热力图口径：364 格，横走一周 7 格
  assert.equal(P.cursorStepOf(100, "ArrowLeft", 364, 7), 93);
  assert.equal(P.cursorStepOf(100, "ArrowRight", 364, 7), 107);
  assert.equal(P.cursorStepOf(100, "ArrowUp", 364, 7), 99);
  assert.equal(P.cursorStepOf(100, "ArrowDown", 364, 7), 101);
  assert.equal(P.cursorStepOf(100, "Home", 364, 7), 0);
  assert.equal(P.cursorStepOf(100, "End", 364, 7), 363);
  assert.equal(P.cursorStepOf(0, "ArrowLeft", 364, 7), 0);      // 左越界钳回
  assert.equal(P.cursorStepOf(363, "ArrowDown", 364, 7), 363);  // 下越界钳回
  assert.equal(P.cursorStepOf(100, "Tab", 364, 7), 100);        // 非法键不动（Tab 要能走掉）
  assert.equal(P.cursorStepOf(100, "Enter", 364, 7), 100);
  // 趋势图口径：stride=1
  assert.equal(P.cursorStepOf(3, "ArrowRight", 30, 1), 4);
  assert.equal(P.cursorStepOf(3, "ArrowLeft", 30, 1), 2);
  // 坏输入
  assert.equal(P.cursorStepOf(NaN, "ArrowRight", 10, 1), 1);
  assert.equal(P.cursorStepOf(-5, "End", 10, 1), 9);
  assert.equal(P.cursorStepOf(3, "ArrowRight", 0, 1), 0);
  assert.equal(P.cursorStepOf(3, "ArrowRight", 10, 0), 4); // stride 兜 1
});

test("backfillUiOf：空闲=空态文案；跟踪=进度文案 + 空态换成「正在回填」；无进度兜底句", { timeout: 5000 }, () => {
  const idle = P.backfillUiOf(null);
  assert.deepEqual(idle, {
    emptyTitle: "暂无使用数据",
    emptyDesc: "开始对话后这里会显示 Token 活动与模型用量；若刚装上插件，历史会话会在后台自动补进来。",
  });
  const scanning = P.backfillUiOf({ tracking: true, scanned: 3, total: 12 });
  assert.equal(scanning.emptyTitle, "正在回填历史会话…");
  assert.equal(scanning.emptyDesc, "已扫 3/12 会话，完成后这里会自动显示统计。");
  const noProgress = P.backfillUiOf({ tracking: true, scanned: null, total: 0 });
  assert.equal(noProgress.emptyDesc, "历史多时需要几分钟，完成后这里会自动显示统计。");
  // 跟踪中但 total=0（刚受理、还没扫出清单）同样走无进度分支
  assert.equal(P.backfillUiOf({ tracking: true, scanned: 0, total: 0 }).emptyDesc, "历史多时需要几分钟，完成后这里会自动显示统计。");
  // 跟踪结束（含放弃）=回到空态文案
  assert.equal(P.backfillUiOf({ tracking: false, scanned: 12, total: 12 }).emptyTitle, "暂无使用数据");
});
//#endregion

//#region 面板版式回归（本次改版：应用用量徽章 / 时间范围两档 / 文案对齐）
// 版式类断言走源码扫描：渲染层是 React.createElement 桩，DOM 树不可靠，
// 而「徽章文案在不在」「范围档位是不是两档」这类改动必须被钉住，防止回退。
const clientSrc = await (await import("node:fs/promises")).readFile(
  new URL("../lib/client.js", import.meta.url), "utf8");

test("面板头部带「应用用量」徽章", { timeout: 5000 }, () => {
  assert.ok(clientSrc.includes('"应用用量"'), "标题旁缺少「应用用量」徽章文案");
  assert.ok(clientSrc.includes(".dus-badge"), "缺少 .dus-badge 样式");
  // 正常态与错误兜底态各有一处标题——两处都要带徽章，否则崩了就没徽章了
  const badgeCount = clientSrc.split('"应用用量"').length - 1;
  assert.equal(badgeCount, 2, "「应用用量」徽章应出现在正常态与错误兜底态两处标题");
});

test("时间范围只暴露「近 7 日 / 近 30 日」两档", { timeout: 5000 }, () => {
  const m = clientSrc.match(/const RANGE_MODES = \[([\s\S]*?)\];/);
  assert.ok(m !== null, "未找到 RANGE_MODES 定义");
  const labels = [...m[1].matchAll(/label:\s*"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(labels, ["近 7 日", "近 30 日"]);
  // 「今日」档已从 UI 移除，但底层 range=1 分支仍保留（trend 路由仍支持 days=1）
  assert.ok(!m[1].includes("今日"), "RANGE_MODES 不应再含「今日」档");
});

test("范围标题与峰值标签逐字对齐设计稿", { timeout: 5000 }, () => {
  assert.ok(clientSrc.includes('"时间范围"'), "范围行标题应为「时间范围」");
  assert.ok(!clientSrc.includes('"趋势与模型用量"'), "旧标题「趋势与模型用量」应已移除");
  const cells = P.summaryCellsOf({ totalTokens: 100, peakDay: { date: "2026-10-03", tokens: 50 } });
  assert.equal(cells[1].label, "峰值 Token 数");
});

test("页脚只有「刷新」，没有「回填历史」按钮", { timeout: 5000 }, () => {
  assert.ok(!clientSrc.includes('"回填历史"'), "页脚不应再有「回填历史」按钮文案");
  assert.ok(!clientSrc.includes("handleBackfill"), "手动回填链路应已移除");
  assert.ok(!clientSrc.includes("api.backfill("), "客户端不应再 POST 触发回填");
  // 宿主侧接口仍在（供外部触发），只是面板不给入口
  assert.ok(clientSrc.includes('backfillStatus'), "回填进度读取仍需保留");
});

test("摘要条含「缓存命中率」一格", { timeout: 5000 }, () => {
  const cells = P.summaryCellsOf({
    totalTokens: 1000, peakDay: { date: "2026-10-03", tokens: 500 },
    cacheReadTokens: 750, uncachedInputTokens: 250, cacheHitRate: 75,
  });
  assert.equal(cells.length, 6);
  assert.equal(cells[2].key, "cache");
  assert.equal(cells[2].label, "缓存命中率");
  assert.equal(cells[2].value, "75.0%");
});

test("热力图 tooltip 用万/亿简写而非完整千分位", { timeout: 5000 }, () => {
  // 造一天 1.2 亿 token：tooltip 应显示「1.2亿 tokens」而不是「120,000,000 tokens」
  const today = new Date();
  const cols = P.hmColumnsOf([{ date: P.dateKey(today), tokens: 120000000, turns: 3 }]);
  const render = P.hmRenderOf(cols, "daily");
  const flat = render.map((c) => c.cells).flat();
  const titles = flat.map((c) => c.title).filter((t) => t !== "");
  assert.ok(titles.length > 0, "当天应有 tooltip");
  assert.ok(titles[0].includes("1.2亿 tokens"), "tooltip 应为万/亿简写，实际：" + titles[0]);
  assert.ok(!titles[0].includes("120,000,000"), "tooltip 不应再显示完整千分位：" + titles[0]);
});

test("趋势图图例纯展示：不可点击隐藏，全部模型恒列出", { timeout: 5000 }, () => {
  assert.ok(!clientSrc.includes("hiddenKeys"), "不应再有「图例点掉模型」的状态");
  assert.ok(!clientSrc.includes("dus-legendBtn"), "不应再有可点击图例的样式类");
  assert.ok(!clientSrc.includes("toggleKey"), "不应再有图例切换逻辑");
  assert.ok(clientSrc.includes("dus-legendItem"), "应有纯展示图例的样式类");
  // 图例容器用 span 而非 button：不可聚焦、不可点击
  const legendBlock = clientSrc.slice(clientSrc.indexOf('className: "dus-legend"'), clientSrc.indexOf('className: "dus-legend"') + 400);
  assert.ok(legendBlock.includes('el("span"'), "图例项应渲染为 span（不可点击）");
  assert.ok(!legendBlock.includes('el("button"'), "图例项不应是 button");
});

test("判废的 seq 登记必须在 await 之前（否则慢响应会覆盖快响应的 seq）", { timeout: 5000 }, () => {
  // 竞态：拍 A（seq 小）慢、拍 B（seq 大）快。若 seq 在响应回来后才登记，
  // A 后完成时会把 keySeqRef 覆盖成旧值，令过期响应被误判为「这一路最新」而落地。
  const registerIdx = clientSrc.indexOf("keySeqRef.current[job[0]] = seq;");
  assert.ok(registerIdx > 0, "未找到 keySeqRef 登记点");
  const awaitIdx = clientSrc.indexOf("await Promise.allSettled(jobs.map");
  assert.ok(awaitIdx > 0, "未找到 allSettled 调用");
  assert.ok(registerIdx < awaitIdx, "seq 登记必须早于 await，否则慢响应会覆盖快响应的 seq");
  // 且只许递增（并发拍下后发者 seq 更大，不能被先发者反向覆盖）
  assert.ok(clientSrc.includes("seq > prev"), "seq 登记必须只增不减");
});

test("client 模块 id 必须与包名逐字一致（否则宿主拒绝加载整个插件）", { timeout: 5000 }, () => {
  // 宿主按包名注册 factory：id 不符会报
  // 「loaded without registering … via __ModuleLoader__.load」并让插件整体加载失败。
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const m = clientSrc.match(/__ModuleLoader__\.load\(\{[\s\S]{0,300}?id:\s*"([^"]+)"/);
  assert.ok(m !== null, "未找到 __ModuleLoader__.load 的 id");
  assert.equal(m[1], pkg.name, "client 模块 id 必须与 package.json 的 name 一致");
});
//#endregion

//#region 渲染冒烟（防「纯函数测过但渲染时炸」）
// 纯函数直测面覆盖不到组件体内的变量引用——曾出现「删掉 visibleRows 别名却漏改 3 处引用」，
// 单元测试全绿、真机整页降级为兜底横幅。
//
// 这里不模拟 React：桩的 useState 顺序对不上组件内部顺序，覆盖不到深层分支
// （曾验证过：注入了同样的 bug，桩版冒烟仍全绿）。改用**静态未定义标识符检查**——
// 把 client.js 里所有 `el(...)`/JSX 位置引用到的标识符，与文件内声明过的标识符集合比对，
// 出现「引用了但从未声明」的名字即失败。这对「改名后漏改引用」这类改动是精准打击。
const UI = captured.__ui;
const react = reactStub;

/** 深度遍历渲染树，收集元素节点（桩的 createElement 返回 {t,p,c}）。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node.t !== undefined) out.push(node);
  if (Array.isArray(node.c)) for (const child of node.c) collect(child, out);
  return out;
}

/** 文件内声明过的标识符：函数/类/const/let/var/参数/属性简写等。 */
function declaredNames(src) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,          // function foo
    /\bclass\s+([A-Za-z_$][\w$]*)/g,              // class Foo
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,    // const foo
    /\b(?:const|let|var)\s*\{([^}]*)\}/g,          // const { a, b }
    /\(([^()]*)\)\s*=>/g,                           // (a, b) => 参数
    /\bfunction\s*\w*\s*\(([^)]*)\)/g,               // function (a, b)
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const chunk = m[1];
      for (const raw of chunk.split(",")) {
        const name = raw.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, "").replace(/^\{/, "").replace(/\}$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  return names;
}

test("渲染冒烟：各组件在典型数据下不抛异常（未定义变量等）", { timeout: 5000 }, () => {
  const days = [{ date: P.dateKey(new Date()), tokens: 120000000, turns: 3 }];
  const points = [{
    date: P.dateKey(new Date()),
    byModel: { "p/m1": 1000, "p/m2": 500 },
    total: 1500,
  }];
  const modelsResp = { models: [{ key: "p/m1", provider: "p", model: "m1", tokens: 1000, share: 0.67 }], total: 1500 };
  const summary = {
    since: "2026-10-01", totalTokens: 1500, peakDay: { date: "2026-10-03", tokens: 900 },
    longestChatMs: 3600000, currentStreakDays: 2, longestStreakDays: 5,
    cacheReadTokens: 900, uncachedInputTokens: 100, cacheHitRate: 90,
  };

  const cases = [
    ["SummaryStrip", () => react.createElement(UI.SummaryStrip, { summary })],
    ["HeatmapCard", () => react.createElement(UI.HeatmapCard, { days, mode: "daily", onMode: () => {}, stale: false })],
    ["TrendCard", () => react.createElement(UI.TrendCard, {
      trend: { granularity: "day", points }, err: false, onRetry: () => {}, rangeLabel: "近 7 日",
    })],
    ["DonutCard", () => react.createElement(UI.DonutCard, { modelsResp, err: false, onRetry: () => {} })],
    ["Pills", () => react.createElement(UI.Pills, { options: [{ value: 7, label: "近 7 日" }], value: 7, onChange: () => {} })],
  ];
  for (const [name, render] of cases) {
    let tree = null;
    assert.doesNotThrow(() => { tree = render(); }, `${name} 渲染抛异常`);
    const nodes = collect(tree);
    assert.ok(nodes.length > 0, `${name} 应渲染出元素`);
  }
});

test("渲染冒烟：覆盖到「悬停态」分支（趋势图的 tooltip 行计算）", { timeout: 5000 }, () => {
  // 桩的 useState 恒返回初值，hover/cursor 恒为 null → 走不到 tipRowsOf 那行。
  // 让桩的前若干次 useState 返回「已悬停」对象，强制走到 tooltip 行计算。
  const points = [{
    date: P.dateKey(new Date()),
    byModel: { "p/m1": 1000, "p/m2": 500 },
    total: 1500,
  }];
  const hoverState = { idx: 0, x: 100, y: 50, cw: 800, ch: 200 };
  const origUseState = reactStub.useState;
  let calls = 0;
  reactStub.useState = (v) => {
    calls += 1;
    // TrendCard 内的 useState 依次是：hover(null) / cursor(null) / ...；
    // 前两个返回悬停/游标态，其余照旧
    if (calls === 1) return [hoverState, () => {}];
    if (calls === 2) return [0, () => {}];
    return origUseState(v);
  };
  try {
    let tree = null;
    assert.doesNotThrow(() => {
      tree = react.createElement(UI.TrendCard, {
        trend: { granularity: "day", points }, err: false, onRetry: () => {}, rangeLabel: "近 7 日",
      });
    }, "趋势图悬停态渲染抛异常（未定义变量等）");
    assert.ok(collect(tree).length > 0);
  } finally {
    reactStub.useState = origUseState;
  }
});

test("渲染冒烟：环图数据含 null 元素不炸（脏数据防护）", { timeout: 5000 }, () => {
  const modelsResp = { models: [null, { key: "p/m1", tokens: 10 }], total: 10 };
  let tree = null;
  assert.doesNotThrow(() => { tree = react.createElement(UI.DonutCard, { modelsResp, err: false, onRetry: () => {} }); });
  assert.ok(collect(tree).length > 0);
});

test("渲染冒烟：图例的可见行与全部模型行恒等（别名不得被拆）", { timeout: 5000 }, () => {
  // visibleRows 是趋势图里多处引用的锚点：拆掉它（改写为 modelRows）极易漏改引用，
  // 而漏改引用只在真机渲染到那几行时才抛 ReferenceError —— 单元测试覆盖不到
  // （桩渲染的 useState 顺序对不上，覆盖不到深层分支；真机 CDP 冒烟才抓到过）。
  // 这里锁死「visibleRows 必须存在且被多处引用」，防止后续再有人把它删掉。
  assert.ok(clientSrc.includes("const visibleRows = modelRows;"), "visibleRows 别名被拆掉了——多处引用会失配");
  const uses = (clientSrc.match(/visibleRows/g) || []).length;
  assert.ok(uses >= 4, "visibleRows 引用点过少（定义 + 至少 3 处使用），疑似残留半拆");
});

//#endregion



