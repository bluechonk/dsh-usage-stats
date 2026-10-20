// dsh-usage-stats —— 纯函数聚合层：daily 数组 → 四条 API 响应形状（SPEC §5）。
// 零依赖零 IO：输入全部是内存数据（daily 对象 / record 对象数组），不读文件也不读时钟——
// 「今天」一律由调用方传 todayIso；不传时回退为输入数据里的最新日期，保证同输入同输出（可测试性）。
// 日期口径全本地时区（isoOf 用 new Date(ms) 的本地语义），与 store 按本地月分文件一致。

const BUCKETS = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/** 四桶之和 = 全项目统一的 totalTokens 当量（SPEC §4，与官方 trajectory「用量」可对账）。 */
function bucketSum(usage) {
  return (
    (usage.uncachedInputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/** 某日 totalTokens 当量 = byModel 各模型四桶和之和（byModel 是日档的权威数据，byHour 只是总量投影）。 */
function dayTokens(daily) {
  let sum = 0;
  for (const slot of Object.values(daily.byModel ?? {})) sum += bucketSum(slot);
  return sum;
}

function sortedDailies(dailies) {
  return [...(dailies ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 模型键 = "<provider>/<model>"；model 名自带斜杠时按首个斜杠拆（provider 不含斜杠由采集侧保证）。 */
function splitKey(key) {
  const slash = key.indexOf("/");
  return slash === -1 ? [key, key] : [key.slice(0, slash), key.slice(slash + 1)];
}

// ---- 日期小工具（本地时区，自给自足） ----

/** 毫秒时间戳 → 本地时区 "YYYY-MM-DD"。 */
export function isoOf(timeMs) {
  const d = new Date(timeMs);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** ISO 日期 ± n 天 → ISO 日期。setDate 跨夏令时由 Date 归一化，日期分量不受影响。 */
export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoOf(dt.getTime());
}

/** SPEC §4 形状的空日聚合。byHour 恒为 24 槽（补零定长），消费方无需判长度。 */
export function emptyDaily(date) {
  return { version: 1, date, byModel: {}, byHour: new Array(24).fill(0), sessions: {} };
}

/**
 * 从某日的 record 数组（SPEC §3 形状）重建日聚合（SPEC §4 形状）。
 * 前置约定（不在此二次过滤，避免静默吞数据）：records 都属于 date 这一天，由调用方分桶；
 * 输入可乱序，内部按 time 稳定排序后「首见」才有确定语义。
 * kind==="replace" 的负桶值正常参与求和——增量流求和 == 官方 totals（SPEC §2 对账基础），不许在这里"修正"负值。
 */
export function rebuildDaily(records, date) {
  const daily = emptyDaily(date);
  // 轮次首见去重集：全局按 (sessionId,turn)、与模型无关（SPEC §4）——同一轮换模型续采不重复计轮
  const seenTurns = new Set();
  // 不按 time 排序：必须与增量路径（updateDailyWithRecord）的「到达顺序」归轮一致——
  // 排序会让「同一轮换模型续采」时轮数归属的模型在重建前后漂移（增量按 append 序、
  // 重建按 time 序），daily 内容对不上账。同一天的 records 必在同一月份文件内，
  // 文件行序 = append 序 = 到达序，故直接按行序遍历即可。
  for (const record of (records ?? [])) {
    const key = `${record.provider}/${record.model}`;
    const usage = record.usage ?? {};
    let slot = daily.byModel[key];
    if (slot === undefined) {
      slot = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 0, turns: 0 };
      daily.byModel[key] = slot;
    }
    for (const bucket of BUCKETS) slot[bucket] += usage[bucket] ?? 0;
    slot.samples += 1; // samples = 记录数：add/replace 都算一次采样观测（replace 是新值替换，也是观测）
    if (record.kind === "add") {
      const turnKey = `${record.sessionId}#${record.turn}`;
      if (!seenTurns.has(turnKey)) {
        seenTurns.add(turnKey);
        slot.turns += 1; // 轮次记在首见那条 record 的模型名下
      }
    }
    daily.byHour[new Date(record.time).getHours()] += bucketSum(usage);
    let sess = daily.sessions[record.sessionId];
    if (sess === undefined) {
      sess = { firstMs: record.time, lastMs: record.time };
      daily.sessions[record.sessionId] = sess;
    }
    if (record.time < sess.firstMs) sess.firstMs = record.time;
    if (record.time > sess.lastMs) sess.lastMs = record.time;
  }
  return daily;
}

/**
 * summary 路由响应（SPEC §5）。
 * streak 口径：连续 = 每天 tokens>0；今天有用量 → 从今天往回数（含今天）；
 * 今天没有 → 从昨天往回数；任一天缺席或为 0 即断。
 * cacheHitRate = 缓存命中 Token /（缓存命中 + 未缓存输入）；分母为 0 时给 null（前端显示「—」）。
 */
export function summarize(dailies, todayIso) {
  const days = sortedDailies(dailies);
  if (days.length === 0) {
    return {
      since: todayIso,
      totalTokens: 0,
      peakDay: null,
      longestChatMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      cacheReadTokens: 0,
      uncachedInputTokens: 0,
      cacheHitRate: null,
    };
  }
  const tokensByDate = new Map();
  let totalTokens = 0;
  let peakDay = null;
  let longestChatMs = 0;
  let cacheReadTokens = 0;
  let uncachedInputTokens = 0;
  for (const daily of days) {
    const tokens = dayTokens(daily);
    totalTokens += tokens;
    tokensByDate.set(daily.date, tokens);
    if (peakDay === null || tokens > peakDay.tokens) peakDay = { date: daily.date, tokens }; // 平局取更早的一天
    for (const slot of Object.values(daily.byModel ?? {})) {
      cacheReadTokens += slot.cacheReadTokens ?? 0;
      uncachedInputTokens += slot.uncachedInputTokens ?? 0;
    }
    // 跨日会话按日截断取 span 是SPEC认可的近似口径
    for (const sess of Object.values(daily.sessions ?? {})) {
      const span = Math.max(0, (sess.lastMs ?? 0) - (sess.firstMs ?? 0));
      if (span > longestChatMs) longestChatMs = span;
    }
  }
  let current = 0;
  let cursor = (tokensByDate.get(todayIso) ?? 0) > 0 ? todayIso : addDaysIso(todayIso, -1);
  while ((tokensByDate.get(cursor) ?? 0) > 0) {
    current += 1;
    cursor = addDaysIso(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const daily of days) {
    if (tokensByDate.get(daily.date) <= 0) continue;
    run = prev !== null && addDaysIso(prev, 1) === daily.date ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = daily.date;
  }
  const hitDenom = cacheReadTokens + uncachedInputTokens;
  return {
    since: days[0].date,
    totalTokens,
    peakDay,
    longestChatMs,
    currentStreakDays: current,
    longestStreakDays: longest,
    cacheReadTokens,
    uncachedInputTokens,
    cacheHitRate: hitDenom > 0 ? (cacheReadTokens / hitDenom) * 100 : null,
  };
}

/**
 * heatmap 路由响应。sinceDateIso 给定时只含 >= since 的日期（路由 ?days=N 由调用方换算成 since）；
 * 0 用量但有档的日照常返回（SPEC「含 0 日」）。当日无用量 → 无 daily 文件 → 本层不伪造补零：
 * 热力图格子由 client 按日历网格铺，缺席日期自然渲染为空档。
 */
export function heatmapDays(dailies, sinceDateIso) {
  const days = [];
  for (const daily of sortedDailies(dailies)) {
    if (sinceDateIso !== undefined && daily.date < sinceDateIso) continue;
    let turns = 0;
    for (const slot of Object.values(daily.byModel ?? {})) turns += slot.turns ?? 0;
    days.push({ date: daily.date, tokens: dayTokens(daily), turns });
  }
  return { days };
}

/**
 * trend 路由响应。
 * days=1 → 24 个整点（label "0时".."23时"）。模型×小时只能来自 records 级数据（byHour 只有总量）：
 * 给了当日 records（数组）时按 模型×小时 聚合，且 total 与 byModel 同源（每点 total === ΣbyModel）；
 * 没给（undefined/省略）时 byModel 为空对象、total 退回 daily.byHour。
 * days=7|30 → 按日一点，窗口 = [end-(N-1), end] 闭区间；窗口内无数据的日补零点——折线需要连续点列，
 * 空缺会造成 X 轴间距失真（与 heatmap 的稀疏不同：折线没有"空格子"表达方式）。
 */
export function trendPoints(dailies, days, dayRecords, todayIso) {
  const all = sortedDailies(dailies);
  const end = todayIso ?? (all.length > 0 ? all[all.length - 1].date : undefined);
  if (days === 1) {
    const daily = end === undefined ? undefined : all.find((d) => d.date === end);
    const hourly = Array.from({ length: 24 }, () => ({})); // 每小时: 模型键 → tokens
    if (Array.isArray(dayRecords)) {
      for (const record of dayRecords) {
        const key = `${record.provider}/${record.model}`;
        const hour = new Date(record.time).getHours();
        const byModel = hourly[hour];
        byModel[key] = (byModel[key] ?? 0) + bucketSum(record.usage ?? {});
      }
    }
    const points = hourly.map((modelMap, hour) => {
      if (!Array.isArray(dayRecords)) {
        return { label: `${hour}时`, byModel: {}, total: daily?.byHour?.[hour] ?? 0 };
      }
      let total = 0;
      for (const value of Object.values(modelMap)) total += value;
      return { label: `${hour}时`, byModel: modelMap, total };
    });
    return { granularity: "hour", points };
  }
  const points = [];
  if (end !== undefined) {
    const byDate = new Map(all.map((d) => [d.date, d]));
    for (let date = addDaysIso(end, -(days - 1)); date <= end; date = addDaysIso(date, 1)) {
      const daily = byDate.get(date);
      const byModel = {};
      let total = 0;
      if (daily !== undefined) {
        for (const [key, slot] of Object.entries(daily.byModel ?? {})) byModel[key] = bucketSum(slot);
        total = dayTokens(daily);
      }
      points.push({ date, byModel, total });
    }
  }
  return { granularity: "day", points };
}

/**
 * models 路由响应。近 N 天 = [end-(N-1), end] 闭区间，end 口径同 trendPoints；
 * days=0 表示**全期**（模型用量环图恒用全期口径，不随时间范围档位变化）。
 * 全期口径两端都不设界：与 summarize 的全期求和保持一致——否则未来时间戳的记录
 * （时钟漂移/时间戳超前）会被这里排除却仍被 summarize 计入，导致「环图总量 ≠ 摘要条累计」。
 * share = tokens/total 保留 4 位小数；净额 <=0 的键不进列表（环形图画不了零/负片）。
 * 本层不做「其他模型」归并：超 6 模型的截断是 client（SPEC §6）的职责，这里必须全量返回。
 */
export function modelShares(dailies, days, todayIso) {
  const all = sortedDailies(dailies);
  const end = todayIso ?? (all.length > 0 ? all[all.length - 1].date : undefined);
  const merged = new Map(); // 模型键 → 四桶和
  const allPeriod = days <= 0; // 全期：不设下界，也不设上界
  if (end !== undefined || allPeriod) {
    const start = allPeriod ? void 0 : addDaysIso(end, -(days - 1));
    for (const daily of all) {
      if (start !== undefined && daily.date < start) continue;
      if (!allPeriod && daily.date > end) continue;
      for (const [key, slot] of Object.entries(daily.byModel ?? {})) {
        merged.set(key, (merged.get(key) ?? 0) + bucketSum(slot));
      }
    }
  }
  let total = 0;
  for (const tokens of merged.values()) total += tokens;
  const models = [...merged.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // tokens 相同按键名字典序，保证输出确定
    .map(([key, tokens]) => {
      const [provider, model] = splitKey(key);
      return {
        key,
        provider,
        model,
        tokens,
        share: total > 0 ? Math.round((tokens / total) * 10000) / 10000 : 0,
      };
    });
  return { models, total };
}
