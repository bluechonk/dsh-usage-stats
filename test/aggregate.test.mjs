// aggregate 层测试：rebuildDaily / summarize / heatmapDays / trendPoints / modelShares 的形状与口径。
// 本层纯同步无 IO，用例全部本地时区构造时间戳（不依赖运行机器的时区偏移）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDaysIso, emptyDaily, heatmapDays, isoOf, modelShares, rebuildDaily, summarize, trendPoints } from "../lib/aggregate.js";

const D0 = "2026-10-01";

/** 本地时区构造某日某时的毫秒时间戳。 */
function ms(dateIso, hour = 0, minute = 0) {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

/** 造一条SPEC §3 形状的 record；usage 四桶按 [uncachedInput, output, cacheRead, cacheWrite] 给。 */
function rec({ date = D0, hour = 0, minute = 0, sid = "s1", provider = "deepseek", model = "deepseek-chat", turn = 1, step = 1, kind = "add", usage = [100, 200, 0, 0] }) {
  return {
    time: ms(date, hour, minute),
    sessionId: sid,
    provider,
    model,
    turn,
    step,
    kind,
    usage: { uncachedInputTokens: usage[0], outputTokens: usage[1], cacheReadTokens: usage[2], cacheWriteTokens: usage[3] },
  };
}

/** 快速造某日 daily：specs = [[provider, model, uncached, output, cacheRead, cacheWrite], ...]，每条一个独立会话。 */
function makeDaily(date, specs) {
  const records = specs.map(([provider, model, u, o, cr, cw], i) =>
    rec({ date, hour: 8 + i, sid: `s-${i}`, provider, model, turn: 1, usage: [u ?? 0, o ?? 0, cr ?? 0, cw ?? 0] }),
  );
  return rebuildDaily(records, date);
}

test("日期小工具：isoOf 本地语义 + addDaysIso 跨月跨年", { timeout: 5000 }, () => {
  assert.equal(isoOf(ms("2026-10-03", 23, 59)), "2026-10-03");
  assert.equal(isoOf(ms("2026-01-01", 0)), "2026-01-01");
  assert.equal(addDaysIso("2026-10-01", -1), "2026-09-30");
  assert.equal(addDaysIso("2026-09-30", 1), "2026-10-01");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysIso("2026-10-03", -7), "2026-09-26");
});

test("emptyDaily：SPEC §4 形状逐字段", { timeout: 5000 }, () => {
  assert.deepEqual(emptyDaily("2026-10-03"), {
    version: 1,
    date: "2026-10-03",
    byModel: {},
    byHour: new Array(24).fill(0),
    sessions: {},
  });
});

test("rebuildDaily：空输入 = emptyDaily", { timeout: 5000 }, () => {
  assert.deepEqual(rebuildDaily([], D0), emptyDaily(D0));
});

test("rebuildDaily：add+replace 混合求和，负桶值自然抵消", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 9, turn: 1, usage: [100, 200, 50, 30] }),
      rec({ hour: 9, minute: 1, turn: 1, kind: "replace", usage: [-40, -60, -50, -30] }),
      rec({ hour: 9, minute: 2, turn: 1, kind: "replace", usage: [10, 10, 5, 5] }),
    ],
    D0,
  );
  const slot = daily.byModel["deepseek/deepseek-chat"];
  assert.deepEqual(
    { u: slot.uncachedInputTokens, o: slot.outputTokens, r: slot.cacheReadTokens, w: slot.cacheWriteTokens },
    { u: 70, o: 150, r: 5, w: 5 },
  );
  assert.equal(slot.samples, 3); // add/replace 都是一次采样观测
  assert.equal(slot.turns, 1); // 同一轮：首见 add 计 1，replace 不计
  assert.equal(daily.byHour[9], 230); // 380 - 180 + 30
});

test("rebuildDaily：turns 去重——同 sid+turn 两条 add 只计 1，跨 sid/轮各计", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 9, sid: "s1", turn: 3, step: 1, usage: [10, 0, 0, 0] }),
      rec({ hour: 9, minute: 1, sid: "s1", turn: 3, step: 2, usage: [20, 0, 0, 0] }), // 同 sid+turn 第二条 add
      rec({ hour: 9, minute: 2, sid: "s1", turn: 3, step: 2, kind: "replace", usage: [-5, 0, 0, 0] }), // replace 不计轮
      rec({ hour: 9, minute: 3, sid: "s2", turn: 3, usage: [7, 0, 0, 0] }), // 换 sid → 新轮
      rec({ hour: 9, minute: 4, sid: "s2", turn: 4, usage: [8, 0, 0, 0] }), // 换 turn → 新轮
    ],
    D0,
  );
  assert.equal(daily.byModel["deepseek/deepseek-chat"].turns, 3);
});

test("rebuildDaily：同轮换模型——轮次记在首见模型名下，全局去重", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 9, sid: "s1", turn: 1, model: "deepseek-chat", usage: [10, 0, 0, 0] }),
      rec({ hour: 9, minute: 1, sid: "s1", turn: 1, model: "deepseek-reasoner", usage: [5, 0, 0, 0] }),
    ],
    D0,
  );
  assert.equal(daily.byModel["deepseek/deepseek-chat"].turns, 1);
  assert.equal(daily.byModel["deepseek/deepseek-reasoner"].turns, 0);
});

test("rebuildDaily：归轮按到达顺序（与增量路径一致），不按 time 排序", { timeout: 5000 }, () => {
  // 增量路径（updateDailyWithRecord）按 append 到达顺序归轮；重建必须同口径，
  // 否则「同一轮换模型续采」时轮数归属的模型会在重建前后漂移（daily 对不上账）。
  // 这里的输入故意乱序：第二条的时间更早，若按 time 排序归轮就会记到另一个模型名下。
  const daily = rebuildDaily(
    [
      rec({ hour: 9, minute: 5, sid: "s1", turn: 1, model: "deepseek-chat", usage: [10, 0, 0, 0] }),
      rec({ hour: 9, minute: 1, sid: "s1", turn: 1, model: "deepseek-reasoner", usage: [5, 0, 0, 0] }),
    ],
    D0,
  );
  assert.equal(daily.byModel["deepseek/deepseek-chat"].turns, 1, "轮次应记在先到的那条（deepseek-chat）名下");
  assert.equal(daily.byModel["deepseek/deepseek-reasoner"].turns, 0, "后到的那条不应重复计轮");
});

test("rebuildDaily：byHour 恒 24 槽，各小时四桶总和", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 0, usage: [10, 0, 0, 0] }),
      rec({ hour: 8, usage: [0, 20, 0, 0] }),
      rec({ hour: 23, usage: [0, 0, 5, 5] }),
    ],
    D0,
  );
  assert.equal(daily.byHour.length, 24);
  const expected = new Array(24).fill(0);
  expected[0] = 10;
  expected[8] = 20;
  expected[23] = 10;
  assert.deepEqual(daily.byHour, expected);
});

test("rebuildDaily：sessions first/last 取自乱序输入的最小/最大 time", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 12, sid: "a", usage: [1, 0, 0, 0] }),
      rec({ hour: 9, sid: "a", usage: [1, 0, 0, 0] }),
      rec({ hour: 10, sid: "b", usage: [1, 0, 0, 0] }),
    ],
    D0,
  );
  assert.deepEqual(daily.sessions, {
    a: { firstMs: ms(D0, 9), lastMs: ms(D0, 12) },
    b: { firstMs: ms(D0, 10), lastMs: ms(D0, 10) },
  });
});

test("summarize：峰值日选取 / totalTokens 全期和 / since 数据起点", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-10-01", [["deepseek", "deepseek-chat", 60, 40, 0, 0]]), // 100
    makeDaily("2026-10-02", [["deepseek", "deepseek-chat", 400, 100, 0, 0]]), // 500 峰值
    makeDaily("2026-10-03", [["deepseek", "deepseek-chat", 150, 50, 0, 0]]), // 200
  ];
  const summary = summarize(dailies, "2026-10-03");
  assert.equal(summary.totalTokens, 800);
  assert.deepEqual(summary.peakDay, { date: "2026-10-02", tokens: 500 });
  assert.equal(summary.since, "2026-10-01");
});

test("summarize：longestChatMs 按 (sessionId, date) 取最大跨度", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 10, sid: "s1", usage: [1, 0, 0, 0] }),
      rec({ hour: 10, minute: 5, sid: "s1", usage: [1, 0, 0, 0] }), // 5 分钟
      rec({ hour: 11, sid: "s2", usage: [1, 0, 0, 0] }),
      rec({ hour: 11, minute: 10, sid: "s2", usage: [1, 0, 0, 0] }), // 10 分钟 ← 最大
    ],
    D0,
  );
  const span5 = ms(D0, 10, 5) - ms(D0, 10); // 期望值用同一时钟算，避免机器夏令时偏移
  const span10 = ms(D0, 11, 10) - ms(D0, 11);
  assert.equal(summarize([daily], "2026-10-03").longestChatMs, span10);
});

test("summarize：streak 三态——今天有 / 今天没有但昨天有 / 断档", { timeout: 5000 }, () => {
  // 今天有：从今天往回连续数（含今天）
  const hasToday = [
    makeDaily("2026-10-01", [["d", "m", 10, 0, 0, 0]]),
    makeDaily("2026-10-02", [["d", "m", 10, 0, 0, 0]]),
    makeDaily("2026-10-03", [["d", "m", 10, 0, 0, 0]]),
  ];
  assert.equal(summarize(hasToday, "2026-10-03").currentStreakDays, 3);
  // 今天没有：从昨天往回数
  const noToday = [hasToday[0], hasToday[1]];
  assert.equal(summarize(noToday, "2026-10-03").currentStreakDays, 2);
  // 断档：昨天往前有空档，只剩今天孤点
  const gap = [makeDaily("2026-09-30", [["d", "m", 10, 0, 0, 0]]), hasToday[2]];
  const summary = summarize(gap, "2026-10-03");
  assert.equal(summary.currentStreakDays, 1);
  assert.equal(summary.longestStreakDays, 1);
});

test("summarize：longestStreak 可大于 current（历史最长段在今天之前）", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-09-30", [["d", "m", 10, 0, 0, 0]]),
    makeDaily("2026-10-01", [["d", "m", 10, 0, 0, 0]]), // 09-30..10-01 连续 2 天
    makeDaily("2026-10-03", [["d", "m", 10, 0, 0, 0]]), // 10-02 断档
  ];
  const summary = summarize(dailies, "2026-10-03");
  assert.equal(summary.currentStreakDays, 1);
  assert.equal(summary.longestStreakDays, 2);
});

test("summarize：空数据形状逐字段断言", { timeout: 5000 }, () => {
  assert.deepEqual(summarize([], "2026-10-03"), {
    since: "2026-10-03",
    totalTokens: 0,
    peakDay: null,
    longestChatMs: 0,
    currentStreakDays: 0,
    longestStreakDays: 0,
    cacheReadTokens: 0,
    uncachedInputTokens: 0,
    cacheHitRate: null,
  });
});

test("summarize：缓存命中率 = 缓存命中 /（缓存命中 + 未缓存输入）；无输入时为 null", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ date: "2026-10-01", hour: 9, sid: "s1", turn: 1, usage: [100, 20, 300, 0] }),
      rec({ date: "2026-10-01", hour: 10, sid: "s1", turn: 2, usage: [100, 20, 100, 0] }),
    ],
    "2026-10-01",
  );
  const s = summarize([daily], "2026-10-01");
  assert.equal(s.cacheReadTokens, 400);
  assert.equal(s.uncachedInputTokens, 200);
  assert.equal(s.cacheHitRate, 400 / 600 * 100);
  // 只有输出、没有输入的日：分母为 0 → null（前端显示「—」，不是 0%）
  const outOnly = rebuildDaily([rec({ date: "2026-10-02", hour: 9, sid: "s2", turn: 1, usage: [0, 20, 0, 0] })], "2026-10-02");
  assert.equal(summarize([outOnly], "2026-10-02").cacheHitRate, null);
});

test("heatmapDays：since 过滤 + tokens/turns 口径 + 含 0 日 + 不给 since 全量升序", { timeout: 5000 }, () => {
  const d1 = rebuildDaily(
    [
      rec({ date: "2026-10-01", hour: 9, sid: "s1", turn: 1, usage: [10, 20, 3, 2] }), // 35
      rec({ date: "2026-10-01", hour: 10, sid: "s1", turn: 2, usage: [1, 1, 0, 0] }), // 2 → 37
    ],
    "2026-10-01",
  );
  const d2 = rebuildDaily([rec({ date: "2026-10-02", hour: 9, sid: "s2", turn: 5, usage: [5, 5, 0, 0] })], "2026-10-02");
  const d3 = rebuildDaily([rec({ date: "2026-10-03", hour: 9, sid: "s3", turn: 1, usage: [0, 0, 0, 0] })], "2026-10-03");

  const full = heatmapDays([d3, d1, d2]); // 乱序输入
  assert.deepEqual(full.days.map((d) => d.date), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.deepEqual(full.days[0], { date: "2026-10-01", tokens: 37, turns: 2 });

  const windowed = heatmapDays([d1, d2, d3], "2026-10-02");
  assert.deepEqual(windowed.days.map((d) => d.date), ["2026-10-02", "2026-10-03"]);
  // 0 用量但有档的日照常返回（SPEC「含 0 日」）；usage 全零的 add 也算一次首见轮——turns 口径独立于 tokens 是否为 0
  assert.deepEqual(windowed.days[1], { date: "2026-10-03", tokens: 0, turns: 1 });
});

test("trendPoints：days=7 窗口只含窗口内日期，窗口内缺档补零点", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-09-25", [["deepseek", "deepseek-chat", 999, 0, 0, 0]]), // 窗口外，不得出现
    makeDaily("2026-09-27", [["deepseek", "deepseek-chat", 10, 20, 0, 0]]),
    // 09-28..10-02 无档 → 补零点
    makeDaily("2026-10-03", [["deepseek", "deepseek-chat", 1, 2, 3, 4]]),
  ];
  const res = trendPoints(dailies, 7, undefined, "2026-10-03");
  assert.equal(res.granularity, "day");
  assert.deepEqual(
    res.points.map((p) => p.date),
    ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"],
  );
  assert.equal(res.points[0].total, 30);
  assert.deepEqual(res.points[1], { date: "2026-09-28", byModel: {}, total: 0 });
  assert.equal(res.points[6].total, 10);
});

test("trendPoints：days=1 恒 24 点，label 逐个断言，无 records 时 total 退回 byHour", { timeout: 5000 }, () => {
  const daily = rebuildDaily(
    [
      rec({ hour: 0, usage: [5, 0, 0, 0] }),
      rec({ hour: 23, usage: [0, 7, 0, 0] }),
    ],
    D0,
  );
  const res = trendPoints([daily], 1); // 不传 todayIso → 窗口锚定输入里的最新日期
  assert.equal(res.granularity, "hour");
  assert.equal(res.points.length, 24);
  for (let hour = 0; hour < 24; hour++) assert.equal(res.points[hour].label, `${hour}时`);
  assert.equal(res.points[0].total, 5);
  assert.equal(res.points[23].total, 7);
  assert.equal(res.points[12].total, 0);
  assert.deepEqual(res.points[0].byModel, {}); // 没有 records 级数据 → byModel 只能为空
});

test("trendPoints：days=1 带当日 records 时 byModel 按模型×小时聚合，total 与 byModel 同源", { timeout: 5000 }, () => {
  const dayRecords = [
    rec({ hour: 9, sid: "s1", turn: 1, provider: "deepseek", model: "deepseek-chat", usage: [10, 20, 0, 0] }),
    rec({ hour: 9, minute: 30, sid: "s1", turn: 2, provider: "openai", model: "gpt-x", usage: [1, 2, 3, 4] }),
    rec({ hour: 10, sid: "s2", turn: 1, provider: "deepseek", model: "deepseek-chat", usage: [100, 0, 0, 0] }),
  ];
  const res = trendPoints([rebuildDaily(dayRecords, D0)], 1, dayRecords, D0);
  assert.deepEqual(res.points[9].byModel, { "deepseek/deepseek-chat": 30, "openai/gpt-x": 10 });
  assert.equal(res.points[9].total, 40); // total === ΣbyModel（同源，不和 byHour 混算）
  assert.deepEqual(res.points[10].byModel, { "deepseek/deepseek-chat": 100 });
  assert.deepEqual(res.points[5].byModel, {});
  assert.equal(res.points[5].total, 0);
});

test("modelShares：tokens 降序 + key 拆 provider/model + 窗口外不计入", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-09-20", [["deepseek", "deepseek-chat", 99999, 0, 0, 0]]), // 窗口外
    makeDaily("2026-10-01", [["deepseek", "deepseek-chat", 80, 20, 0, 0]]), // 100
    makeDaily("2026-10-03", [["deepseek", "deepseek-chat", 100, 100, 0, 0], ["openai", "gpt-x", 150, 50, 0, 0]]), // 200 / 200
  ];
  const res = modelShares(dailies, 7, "2026-10-03");
  assert.equal(res.total, 500);
  assert.deepEqual(
    res.models.map((m) => m.key),
    ["deepseek/deepseek-chat", "openai/gpt-x"], // 300 > 200，降序
  );
  assert.deepEqual(res.models[0], { key: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat", tokens: 300, share: 0.6 });
  assert.equal(res.models[1].provider, "openai");
  assert.equal(res.models[1].model, "gpt-x");
});

test("modelShares：share 各自 0-1 且总和≈1（4 位小数舍入误差内）", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-10-02", [["a", "m1", 333, 0, 0, 0], ["b", "m2", 333, 0, 0, 0]]),
    makeDaily("2026-10-03", [["a", "m1", 1, 0, 0, 0]]), // 667/334 非整除，逼出舍入
  ];
  const res = modelShares(dailies, 7, "2026-10-03");
  const sum = res.models.reduce((acc, m) => acc + m.share, 0);
  for (const model of res.models) {
    assert.ok(model.share > 0 && model.share <= 1);
    assert.equal(model.share, Math.round((model.tokens / res.total) * 10000) / 10000);
  }
  assert.ok(Math.abs(sum - 1) < 0.001, `share 总和 ${sum} 应≈1`);
});

test("modelShares：超 6 模型不在此层截断——「其他模型」归并是 client（SPEC §6）的职责", { timeout: 5000 }, () => {
  const specs = Array.from({ length: 8 }, (_, i) => [`p${i}`, `m${i}`, 10, 0, 0, 0]);
  const res = modelShares([makeDaily("2026-10-03", specs)], 7, "2026-10-03");
  assert.equal(res.models.length, 8, "聚合层必须全量返回，截断/归并留给渲染层");
  assert.equal(res.models.every((m) => m.tokens > 0), true);
});

test("modelShares：days=0 = 全期口径——窗口外的历史用量也计入（模型用量环图恒用全期）", { timeout: 5000 }, () => {
  const dailies = [
    makeDaily("2026-09-20", [["deepseek", "deepseek-chat", 99999, 0, 0, 0]]), // 远早于窗口
    makeDaily("2026-10-01", [["deepseek", "deepseek-chat", 80, 20, 0, 0]]), // 100
    makeDaily("2026-10-03", [["deepseek", "deepseek-chat", 100, 100, 0, 0]]), // 200
  ];
  const all = modelShares(dailies, 0, "2026-10-03");
  assert.equal(all.total, 99999 + 100 + 200);
  assert.equal(all.models.length, 1);
  assert.equal(all.models[0].tokens, 99999 + 100 + 200);
  // 对照：days=7 只算窗口内
  const win = modelShares(dailies, 7, "2026-10-03");
  assert.equal(win.total, 300);
});

test("modelShares 全期与 summarize 全期口径一致（环图总量 === 摘要条累计）", { timeout: 5000 }, () => {
  // 未来时间戳的记录（时钟漂移/时间戳超前）：summarize 不封顶，modelShares 也必须不封顶，
  // 否则「模型用量」环图总量会小于「累计 Token 数」——口径对不上。
  const dailies = [
    makeDaily("2026-10-01", [["deepseek", "deepseek-chat", 80, 20, 0, 0]]), // 100
    makeDaily("2026-10-03", [["deepseek", "deepseek-chat", 100, 100, 0, 0]]), // 200
    makeDaily("2026-10-09", [["deepseek", "deepseek-chat", 5, 5, 0, 0]]), // 10（未来日期）
  ];
  const today = "2026-10-03";
  const sum = summarize(dailies, today);
  const shares = modelShares(dailies, 0, today);
  assert.equal(shares.total, sum.totalTokens, "全期口径下环图总量必须等于摘要条累计");
  assert.equal(shares.total, 310); // 100 + 200 + 10
  // 近 N 日窗口仍按今天封顶（未来日期不进窗口）
  assert.equal(modelShares(dailies, 7, today).total, 300);
});

test("聚合层：含 null 元素的 daily 数组不抛错（畸形输入不得击穿整条路由）", { timeout: 5000 }, () => {
  // 生产路径已过滤 null，但这几个函数是 __pure 直测面 / 未来其它调用方的入口
  assert.doesNotThrow(() => modelShares([null], 0, "2026-10-20"), "modelShares 遇 null 应跳过而非抛错");
  assert.doesNotThrow(() => heatmapDays([null]), "heatmapDays 遇 null 应跳过而非抛错");
  assert.doesNotThrow(() => trendPoints([null], 7), "trendPoints 遇 null 应跳过而非抛错");
  assert.doesNotThrow(() => summarize([null], "2026-10-20"), "summarize 遇 null 应跳过而非抛错");
});

test("addDaysIso：非法日期抛错而非静默产出 NaN-NaN-NaN", { timeout: 5000 }, () => {
  // "NaN-NaN-NaN" 是 SPEC §5 记录的「静默空白且无报错」故障模式
  assert.throws(() => addDaysIso("abc", 0), /非法日期/);
  assert.throws(() => addDaysIso(20260101, 1), /非法日期/);
  assert.throws(() => addDaysIso("", 0), /非法日期/);
  assert.equal(addDaysIso("2026-02-28", 1), "2026-03-01", "合法日期仍正常");
  assert.equal(addDaysIso("2024-02-28", 1), "2024-02-29", "闰年 2/29");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01", "跨年");
});

test("summarize：缓存命中率钳到 0-100（跨午夜 replace 差值不得算出 >100% 或负比率）", { timeout: 5000 }, () => {
  // 跨午夜：add 落前一天、replace 落后一天 → 次日桶为负 → 分子/分母可能为负
  const daily = {
    version: 1, date: "2026-10-03",
    byModel: { "p/m": { uncachedInputTokens: -100, outputTokens: 0, cacheReadTokens: -50, cacheWriteTokens: 0, samples: 1, turns: 0 } },
    byHour: new Array(24).fill(0),
    sessions: {},
  };
  const s = summarize([daily], "2026-10-03");
  assert.ok(s.cacheHitRate === null || (s.cacheHitRate >= 0 && s.cacheHitRate <= 100), `命中率应落在 0-100，实际 ${s.cacheHitRate}`);
});
