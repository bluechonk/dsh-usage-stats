// dsh-usage-stats — 落盘层（SPEC §3）。
// 目录布局（storageRoot 默认 ~/.dsh/usage-stats/，测试注入临时目录）：
//   records-YYYY-MM.jsonl   笔级增量流水：按 record.time 本地月份归文件，一行一条 JSON 追加写
//   daily/YYYY-MM-DD.json   日聚合缓存（aggregate.js 的输入），原子写（tmp+rename）
//   lock                    单写者锁：O_EXCL 创建写 pid+时间戳；持有中被再获取=抛错（fail loud，
//                           是否降级由调用方决定）；mtime 距今 ≥5min 视为持有者已死，可接管
//   backfill-marker.json    回填游标 v4 {done:[sid,…], watermarks:{sid:seq}, mtimes:{sid:mtimeMs}, updatedAt}
//                           watermarks 语义（已收窄）=「bootstrap 基线」：仅 mtime 哨兵/空会话
//                           分支写的起点 seq；常规记账水位不落 marker——records 是唯一真源（每条
//                           record 带 seq），水位从 records 推导，live 完全不写 marker
// 写盘纪律：append 写失败不炸宿主轮次——丢弃该条并内部计数（首条 warn、此后每满
// 连续 10 条升 error，防日志风暴）；读失败按空数据处理但记 warn（可见降级，不静默吞）。
import { utimesSync, 
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const RECORDS_RE = /^records-\d{4}-\d{2}\.jsonl$/;
const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // daily 文件名即日期；顺带挡路径注入
const LOCK_STALE_MS = 5 * 60 * 1000;

/** 时间戳 → "YYYY-MM"（本地时区——月轮转与聚合的归档口径必须与用户感知的月份一致）。 */
export function monthOf(timeMs) {
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) throw new Error(`dsh-usage-stats: monthOf 收到非法时间戳 ${String(timeMs)}`);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeLog(log) {
  // 宿主 logger 可缺（独立工具/测试直跑）：降级 console；日志本身永不炸主流程
  const wrap = (level, fallback) => (message, error) => {
    try {
      if (log !== void 0 && log !== null && typeof log[level] === "function") log[level](message, error ?? "");
      else fallback(`[dsh-usage-stats] ${message}`, error ?? "");
    } catch {
      /* 日志永不炸主流程 */
    }
  };
  return {
    info: wrap("info", console.log),
    warn: wrap("warn", console.warn),
    error: wrap("error", console.error),
  };
}

export function createStore({ storageRoot, log, now } = {}) {
  if (typeof storageRoot !== "string" || storageRoot.length === 0) {
    throw new Error("dsh-usage-stats: storageRoot 必须是非空字符串");
  }
  if (now !== void 0 && typeof now !== "function") throw new Error("dsh-usage-stats: now 必须是函数");
  const logger = normalizeLog(log);
  const clock = now ?? Date.now;
  const lockPath = join(storageRoot, "lock");
  const dailyDir = join(storageRoot, "daily");
  const markerPath = join(storageRoot, "backfill-marker.json");
  let lockHeld = false; // 只标记本实例是否持有；互斥本体由文件系统 O_EXCL 保证
  let consecutiveWriteFailures = 0;

  function assertDate(date) {
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      throw new Error(`dsh-usage-stats: 非法日期 "${String(date)}"（应为 YYYY-MM-DD）`);
    }
  }

  /** 同目录 tmp + rename：rename 同盘原子，半途崩溃最多留 tmp 残片，正本不损。 */
  function atomicWriteJson(target, value) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, target);
  }

  /** 追加一条笔级增量到当月 JSONL。永不抛（写失败纪律见文件头）；返回是否落盘成功——
   *  调用方（index.js）据此决定要不要推进折叠水位：落盘失败的事件不能标"已记账"。
   *  写前先校验锁归属（SPEC §3）：锁已被陈旧接管的原写者不能继续写，否则双实例互抹账本。
   *  归属校验失败同样按「没落盘」处理（返回 false），上层据此不推进水位。 */
  function append(record) {
    try {
      assertOwnership();
    } catch (error) {
      consecutiveWriteFailures += 1;
      if (consecutiveWriteFailures === 1) logger.error("写锁已易主，停止写入用量记录（不推进记账水位）", error);
      else if (consecutiveWriteFailures % 10 === 0) logger.error(`写锁丢失后已连续 ${consecutiveWriteFailures} 条记录未落盘`, error);
      return false;
    }
    try {
      mkdirSync(storageRoot, { recursive: true });
      const file = join(storageRoot, `records-${monthOf(record?.time)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      if (consecutiveWriteFailures > 0) consecutiveWriteFailures = 0; // 恢复即清零，下次失败重新从首条计
      return true;
    } catch (error) {
      consecutiveWriteFailures += 1;
      if (consecutiveWriteFailures === 1) logger.warn("用量记录写盘失败，丢弃该条", error);
      else if (consecutiveWriteFailures % 10 === 0) logger.error(`用量记录已连续 ${consecutiveWriteFailures} 条写盘失败`, error);
      return false;
    }
  }

  /** 全量流水：文件名月份序 + 文件内行序。缺目录=无记录（首次装载常态，不算失败）。 */
  function readAllRecords() {
    let names;
    try {
      names = readdirSync(storageRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn("用量流水目录读取失败，按无记录处理", error);
      return [];
    }
    const records = [];
    for (const name of names.filter((item) => RECORDS_RE.test(item)).sort()) {
      let text;
      try {
        text = readFileSync(join(storageRoot, name), "utf8");
      } catch (error) {
        logger.warn(`用量流水 ${name} 读取失败，按空文件处理`, error);
        continue;
      }
      let lineNo = 0;
      for (const line of text.split("\n")) {
        lineNo += 1;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue; // 末尾换行产生的空行不是坏行
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed === null || typeof parsed !== "object") throw new Error("不是记录对象");
          records.push(parsed);
        } catch (error) {
          // 坏行=半截写崩溃的残迹：跳过不炸读取，但必须留痕
          logger.warn(`用量流水 ${name} 第 ${lineNo} 行损坏，跳过`, error);
        }
      }
    }
    return records;
  }

  /** 读日聚合缓存；无缓存（含读坏）返回 null——聚合侧以 records 全量重建兜底，故 null 是合法降级。 */
  function readDaily(date) {
    assertDate(date);
    let text;
    try {
      text = readFileSync(join(dailyDir, `${date}.json`), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn(`日聚合 ${date} 读取失败，按无缓存处理`, error);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      logger.warn(`日聚合 ${date} 解析失败，按无缓存处理`, error);
      return null;
    }
  }

  /** 写日聚合缓存。与 append 不同：抛错给调用方（写缓存失败由调用方决定可见降级）。 */
  function writeDaily(date, obj) {
    assertDate(date);
    atomicWriteJson(join(dailyDir, `${date}.json`), obj);
  }

  /** 删幻影日档（records 不再覆盖的日期）：ENOENT 视为已删。 */
  function removeDaily(date) {
    assertDate(date);
    try {
      rmSync(join(dailyDir, `${date}.json`));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  /** 有聚合文件的日期（升序）；tmp 残片不匹配正名规则，天然被过滤。 */
  function listDailyDates() {
    let names;
    try {
      names = readdirSync(dailyDir);
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn("daily 目录读取失败，按无缓存处理", error);
      return [];
    }
    return names.filter((name) => DAILY_RE.test(name)).map((name) => name.slice(0, 10)).sort();
  }

  /** 锁文件指纹（mtime+size）：归属校验的节流依据——锁被接管时指纹必然跳变。
   *  声明必须在 acquireLock 之前（下面会写它）。 */
  let ownershipFingerprint = "";

  function acquireLock() {
    // 内存态 lockHeld 可能是「已被别人陈旧接管后残留」——此时不能直接 return，
    // 否则调用方会误判自己仍是写者（与真持有者并行写）。以盘上 pid 为准复核。
    if (lockHeld) {
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        owner = null;
      }
      if (owner?.pid === process.pid) return; // 确实还归本实例，幂等返回
      lockHeld = false; // 归属已易主：走下面的真正抢锁流程
    }
    mkdirSync(storageRoot, { recursive: true });
    const payload = () => JSON.stringify({ pid: process.pid, at: clock() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(lockPath, payload(), { flag: "wx" }); // O_EXCL：互斥由文件系统原子保证
        lockHeld = true;
        ownershipFingerprint = lockFingerprint(); // 记录指纹：后续写入据此跳过昂贵的读+parse
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      let mtimeMs;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch (error) {
        if (error?.code === "ENOENT") continue; // 持有者刚好释放，重试抢占
        throw error;
      }
      if (clock() - mtimeMs < LOCK_STALE_MS) {
        throw new Error(`dsh-usage-stats: 另一实例持有锁 ${lockPath}（mtime 距今 <5min），拒绝并行写`);
      }
      // 陈旧锁接管。TOCTOU 防护：两个实例可能同时判定同一把锁陈旧，
      // 若各自 rmSync 再 wx，可能删掉对方刚建的新锁 → 双写者。
      // 用独占 claim 文件给接管过程串行化：抢不到 claim 的实例退避重试。
      //
      // claim 必须与锁同样按陈旧判定回收：否则「持锁实例在接管流程中被 SIGKILL」
      // 留下的 claim 会永久封锁接管——插件就永久停在只读镜像态、不再采集新用量
      // （面板看着正常，数据悄悄停更），且别人也进不来。
      const claimPath = `${lockPath}.claim`;
      let claimed = false;
      try {
        writeFileSync(claimPath, payload(), { flag: "wx" });
        claimed = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        // 已有 claim：若它已陈旧（持有者在接管流程中死了）则回收，否则本轮跳过
        let claimAge = Infinity;
        try {
          claimAge = clock() - statSync(claimPath).mtimeMs;
        } catch {
          claimAge = Infinity; // claim 已消失：当作陈旧，直接抢
        }
        if (claimAge < LOCK_STALE_MS) continue; // 别人正在接管，本轮跳过
        try {
          rmSync(claimPath, { force: true });
        } catch {
          continue; // 回收失败（被占用）：本轮跳过，下轮再试
        }
        try {
          writeFileSync(claimPath, payload(), { flag: "wx" });
          claimed = true;
        } catch {
          continue; // 别人同时抢到了
        }
      }
      try {
        // 拿到接管权后复核 mtime：可能刚被持有者续期过（不再是陈旧锁）
        let fresh;
        try {
          fresh = statSync(lockPath).mtimeMs;
        } catch (error) {
          if (error?.code === "ENOENT") continue; // 持有者已释放，直接下一轮 wx
          throw error;
        }
        if (clock() - fresh < LOCK_STALE_MS) continue; // 已被续期，不再是陈旧锁
        rmSync(lockPath, { force: true });
        try {
          writeFileSync(lockPath, payload(), { flag: "wx" });
        } catch (error) {
          // 锁被别人抢走：不能停在「已持锁」的半状态（否则本实例判为写者却其实没锁）
          lockHeld = false;
          throw error;
        }
        lockHeld = true;
        ownershipFingerprint = lockFingerprint(); // 记录指纹：后续写入据此跳过昂贵的读+parse
        return;
      } finally {
        // rm 不得抛出：claim 残留会封锁后续接管（由上面的陈旧判定回收）
        if (claimed) {
          try {
            rmSync(claimPath, { force: true });
          } catch {
            /* 残留的 claim 会被下一次接管按陈旧判定回收 */
          }
        }
      }
    }
    throw new Error(`dsh-usage-stats: 锁竞争重试耗尽 ${lockPath}`);
  }

  /** 写前归属校验：锁已被别人接管时抛 LOCK_LOST。
   *  写入路径（append / writeBackfillMarker）必须先过这一关——否则被抢锁的
   *  原写者会用陈旧内存快照继续写，双实例互抹账本（SPEC §3 明文要求）。
   *
   *  节流：读锁文件 + JSON.parse 实测占 append 总成本约 61%（2000 次 append 里
   *  975ms 花在归属校验），回填 10 万条要多花约 50s。
   *  节流用**锁文件指纹**（mtime+size）而非固定时间窗：锁被接管时指纹必然跳变，
   *  立刻触发重新校验，不存在「窗口内漏检易主」的窗口（比纯时间窗更严谨）。
   *  指纹读取只是一次 stat，比读+parse 便宜一个数量级。 */

  function lockFingerprint() {
    try {
      const st = statSync(lockPath);
      return st.mtimeMs + ":" + st.size;
    } catch {
      return "missing";
    }
  }

  function assertOwnership() {
    if (!lockHeld) {
      const err = new Error("dsh-usage-stats: 本实例未持有写锁，拒绝写入");
      err.code = "LOCK_LOST";
      throw err;
    }
    // 指纹未变 → 锁文件自上次校验后没被动过 → 归属仍成立，跳过昂贵的读+parse
    if (lockFingerprint() === ownershipFingerprint) return;
    let owner;
    try {
      owner = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (error) {
      error.code = "LOCK_LOST"; // 锁读不到/解析失败：按归属丢失处理，不当瞬时 IO 错误放过
      throw error;
    }
    if (owner?.pid !== process.pid) {
      const err = new Error(`dsh-usage-stats: 锁已易主（pid ${owner?.pid}），本实例不再是写者`);
      err.code = "LOCK_LOST";
      throw err;
    }
    ownershipFingerprint = lockFingerprint();
  }

  /** 心跳续期：持有中把锁文件 mtime 拨到当前——「陈旧」判定（mtime≥5min）从此等价于持有者死亡。
   *  写前校验归属：锁被陈旧接管（或消失）时抛 LockLost——不校验的话，被抢锁的
   *  原写者会以陈旧内存快照继续覆写 marker（幽灵写者，双实例互抹账本）且无任何感知。 */
  function touchLock() {
    if (!lockHeld) return;
    let owner;
    try {
      owner = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") error.code = "LOCK_LOST";
      ownershipFingerprint = ""; // 归属异常：作废节流指纹，下一次写必须重新校验
      throw error;
    }
    if (owner?.pid !== process.pid) {
      const err = new Error(`dsh-usage-stats: 锁已易主（pid ${owner?.pid}），本实例不再是写者`);
      err.code = "LOCK_LOST";
      ownershipFingerprint = ""; // 已确认易主：作废节流指纹
      throw err;
    }
    utimesSync(lockPath, new Date(clock()), new Date(clock()));
    ownershipFingerprint = lockFingerprint(); // 续期改了 mtime：同步指纹，否则下次写会多校验一次
  }

  function close() {
    if (!lockHeld) return;
    lockHeld = false;
    // 锁归属校验：本实例的锁可能已被别的实例陈旧接管，删错会把接管者解锁成双写者。
    // 读不到/解析失败时**不能**删——那把锁可能是别人正在创建的半成品，
    // 删掉等于给并发实例开闸；交给 5min 陈旧规则接管更安全。
    let owned = false;
    try {
      owned = JSON.parse(readFileSync(lockPath, "utf8"))?.pid === process.pid;
    } catch {
      owned = false;
    }
    if (!owned) {
      logger.warn("锁归属不可确认，释放跳过（交给 5min 陈旧规则接管）");
      return;
    }
    try {
      rmSync(lockPath);
    } catch {
      /* 锁文件已被接管/消失：释放动作不许炸关停流程 */
    }
  }

  /** 回填触发判据：任何月的流水文件存在即视为"已有数据"。
   *  注：生产回填路径不以本判据决定是否跑（中断恢复后 records 已存在但 done 不全，
   *  靠幂等补齐而不是不跑——见 lib/index.js 的回填触发处）。 */
  function hasAnyRecords() {
    try {
      return readdirSync(storageRoot).some((name) => RECORDS_RE.test(name));
    } catch {
      return false; // 目录不存在=无记录
    }
  }

  /** 读回填游标（v4 形状：{done:[], watermarks:{sid:bootstrap基线}, mtimes:{sid:mtimeMs}, updatedAt}；
   *  兼容 v1 缺 watermarks/mtimes）。watermarks 值必须有限数：损坏值（null 之类 Number()=0）会被
   *  当合法基线引发错折，宁删勿错。 */
  function readBackfillMarker() {
    let text;
    try {
      text = readFileSync(markerPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn("回填游标读取失败，按无游标处理", error);
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (!Array.isArray(parsed.done)) parsed.done = [];
        if (parsed.watermarks === void 0 || parsed.watermarks === null || typeof parsed.watermarks !== "object") parsed.watermarks = {};
        // 水位值必须有限数：损坏值（null 之类 Number()=0）会被当合法水位引发错折，宁删勿错
        for (const key of Object.keys(parsed.watermarks)) {
          if (!Number.isFinite(Number(parsed.watermarks[key]))) delete parsed.watermarks[key];
        }
      }
      return parsed;
    } catch (error) {
      logger.warn("回填游标解析失败，按无游标处理（回填可能重跑）", error);
      return null;
    }
  }

  /** 写回填游标。写前校验锁归属：幽灵写者会抹掉新持有者的 done/水位/哨兵。 */
  function writeBackfillMarker(obj) {
    assertOwnership();
    atomicWriteJson(markerPath, obj);
  }

  return {
    storageRoot,
    append,
    readAllRecords,
    readDaily,
    writeDaily,
    removeDaily,
    listDailyDates,
    acquireLock,
    touchLock,
    assertOwnership,
    hasAnyRecords,
    readBackfillMarker,
    writeBackfillMarker,
    close,
  };
}
