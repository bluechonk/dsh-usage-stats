// dsh-usage-stats client 半边（SPEC §0/§5/§6，v0.2.0 的界面细化见 §6）。
//
// 职责（单文件）：settings.section order 13「使用统计」面板——五格终身摘要条 /
//   Token 活动热力图（每日/每周/累计三档）/ 时间范围胶囊（今日/近 7 日/近 30 日）/
//   每日 Token 趋势折线（手写 monotone 三次插值）/ 模型用量环形图 / 右下刷新按钮；
//   三态（加载中… / 暂无使用数据 / 加载失败+重试）。
//   时效面：60s 轻轮询（silent 档 = summary + 当前 range 的 trend +（range≠1 时）models，
//   另按需补 heatmap；document.hidden 跳拍，回前台立即补一拍）+
//   「更新于 HH:MM」（本轮每一路都成功才推进）；回填面：挂载即读一次状态，未在跑就按需
//   补拉热力图（数据变了才拉，§6），在跑就进入跟踪态（单 ticker，800ms 一拍，
//   「已扫 X/Y 会话」），跑完自动全量刷新。
//
// 数据源（SPEC §5，全部同源相对路径 GET，四路互不拖垮）：
//   /api/dsh-usage-stats/summary · /heatmap?days=366 · /trend?days=1|7|30 · /models?days=7|30
//   演示数据零内置——所有数字来自 API；拿不到就显式降级，绝不静默兜假数。
//
// 主题挂法：官方 dsh-client-ui-theme 的双档载体是 body 属性——浅=body、
//   深=body[data-ds-dark-theme]。
//   因此把 ：root[data-theme=dark|light] 变量表翻译成 body / body[data-ds-dark-theme]
//   两档 CSS 自定义属性，纯 CSS 级联自动跟随官方主题，零 JS 监听（同生态插件同哲学：
//   官方变量自动跟随，插件不自持主题状态）。
//
// 取舍记录（SPEC未覆盖处）：
//   ① 环形图半径取具体值 rO=96/rI=63.4（240 视箱），不用"86%/56%"
//      的比例口径——注释与实现值不一致时以实现值为准。
//   ② 今日档（range=1）环形图：/models 路由只收 7|30，今日分模型用量从
//      /trend?days=1 的 byModel 逐点求和得出（同一 contract API，数值等价）。
//   ③ 图表 tooltip/图例 token 数用千分位完整数字（SPEC §6 明文）；摘要条与环形
//      中心用「x.x 万 / x.x 亿」短格式（窄格不溢出）。
//   ④ 模型显示名用SPEC主键 provider/model 全串（models 路由的 key）——不同供应商
//      同名模型会撞色撞名，全串无歧义。
//   ⑤ 趋势折线不封顶模型数、不做「其他模型」归并（归并是环形图的明文要求）；
//      色板 6 色循环取用。>6 模型的同色歧义由「图例点击隐藏」缓解（§6）。
//   ⑥ 热力图 tooltip 跟随SPEC §6 用千分位；短格式属演示口径，以SPEC为准。
//   ⑦ 悬停卡片定宽 230（TIP_W）——定位数学可精确钳位，不做「渲染后量尺寸」的二段定位；
//      热力图/环形图/趋势图共用同一张卡片（§6）。
//
// 样式全部 dus-* 前缀，零官方类名依赖；<style> 注入走 data-plugin-css 去重
//   （热重载原位替换）。组件崩溃经 SectionBoundary 兜底（slot 组件
//   崩溃会拖塌整页设置）。
window.__ModuleLoader__.load({
  // 模块 id 必须与包名逐字一致——宿主按包名注册 factory，id 不符会报
  // 「loaded without registering … via __ModuleLoader__.load」并让整个插件加载失败。
  id: "@bluechonk/dsh-usage-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    const PREFIX = "[dsh-usage-stats] ";

    //#region css（CSS 变量表 dark/light 两档直搬；挂 body 与 body[data-ds-dark-theme]）
    const css = [
      // —— 变量表：浅档在 body，深档覆盖在 body[data-ds-dark-theme]（官方主题载体）——
      "body{--dus-bg:#ffffff;--dus-surface:rgba(0,0,0,.03);--dus-surface70:rgba(0,0,0,.021);" +
        "--dus-border:rgba(0,0,0,.09);--dus-fg:#17171a;--dus-fgsubtle:rgba(23,23,26,.62);--dus-fgfaint:rgba(23,23,26,.40);" +
        "--dus-c1:#0284c7;--dus-c2:#0d9488;--dus-c3:#7c3aed;--dus-c4:#f43f5e;--dus-c5:#6366f1;--dus-c6:#0891b2;" +
        "--dus-hm0:#e2e5ea;--dus-hm1:#cfe4f2;--dus-hm2:#9ecbe8;--dus-hm3:#62aede;--dus-hm4:#2b90d9;--dus-ttbg:#ffffff}",
      "body[data-ds-dark-theme]{--dus-bg:#151517;--dus-surface:rgba(255,255,255,.05);--dus-surface70:rgba(255,255,255,.035);" +
        "--dus-border:rgba(255,255,255,.10);--dus-fg:#ededee;--dus-fgsubtle:rgba(237,237,238,.58);--dus-fgfaint:rgba(237,237,238,.38);" +
        "--dus-c1:#0ea5e9;--dus-c2:#14b8a6;--dus-c3:#8b5cf6;--dus-c4:#fb7185;--dus-c5:#818cf8;--dus-c6:#06b6d4;" +
        "--dus-hm0:#202023;--dus-hm1:#1c3747;--dus-hm2:#194f6a;--dus-hm3:#156d96;--dus-hm4:#118dc5;--dus-ttbg:#232327}",
      // —— 面板骨架 ——
      ".dus-root{display:flex;flex-direction:column;gap:20px;max-width:860px;min-width:0;color:var(--dus-fg)}",
      ".dus-head{display:flex;flex-direction:column;gap:2px}",
      ".dus-titleRow{display:flex;align-items:center;gap:10px}",
      ".dus-title{font-size:24px;font-weight:600;letter-spacing:-.01em}",
      // 「应用用量」徽章：标题右侧的小圆角标签，标识本面板的统计范围
      ".dus-badge{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;background:var(--dus-surface);border:1px solid var(--dus-border);color:var(--dus-fgsubtle);font-size:12px;white-space:nowrap}",
      ".dus-sub{color:var(--dus-fgsubtle);font-size:13px}",
      ".dus-card{background:var(--dus-surface);border-radius:12px;padding:16px}",
      ".dus-cardTight{padding:12px}",
      ".dus-secHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}",
      ".dus-secTitle{font-size:14px;font-weight:500}",
      // —— A1 五格摘要条（自适应换行：宽度不足时整格折行，标签不再截断）——
      // 分隔线不画在格子的 border 上——折行时 border-left/right 必然在行首或行尾留孤线。
      // 改用「1px 列间隙 + 格子的外扩阴影」画线：阴影正好落在间隙里，行与行之间不画线，
      // 因此新行首格左侧不会有竖线；末列阴影溢出容器 1px，被 overflow:hidden 裁掉。
      // Grid 而非 Flex：auto-fit 轨道等宽，末行只有一格时不会被拉成整行宽。
      ".dus-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));column-gap:1px;row-gap:0;overflow:hidden}",
      ".dus-cell{padding:12px 16px;text-align:center;min-width:0;box-shadow:1px 0 0 var(--dus-border)}",
      ".dus-cellV{font-size:16px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dus-cellK{font-size:14px;color:var(--dus-fgsubtle);margin-top:4px;line-height:1.35;overflow-wrap:anywhere}",
      // —— 胶囊 Tab（h-7 = 容器 2px 内衬 + 26px 按钮；激活项反色）——
      ".dus-pills{display:inline-flex;gap:2px;background:var(--dus-surface);border-radius:999px;padding:2px}",
      ".dus-pill{height:26px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--dus-fgsubtle);font-family:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}",
      ".dus-pillOn{background:var(--dus-bg);color:var(--dus-fg);font-weight:500}",
      "body:not([data-ds-dark-theme]) .dus-pillOn{background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      // 焦点环（v0.2.0 §6）：键盘可达面显式可见，不依赖 UA 默认（按钮 border:0 时各浏览器表现不一）
      ".dus-pill:focus-visible,.dus-btnOutline:focus-visible,.dus-hmWrap:focus-visible,.dus-chartWrap:focus-visible{outline:2px solid var(--dus-c1);outline-offset:2px}",
      ".dus-pill:focus-visible{border-radius:999px}",
      // —— A2 热力图（52 列 minmax(0,1fr) 等分容器宽度，任何方向不出滚动条）——
      ".dus-hmWrap{position:relative;border-radius:8px}",
      ".dus-hmGrid{display:grid;grid-template-columns:repeat(52,minmax(0,1fr));gap:0 2px}",
      ".dus-hmCol{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dus-hmCell{aspect-ratio:1;width:100%;min-width:0;border-radius:4px;border:1px solid transparent;display:block;transition:transform .08s}",
      ".dus-hmCellUsed{border-color:var(--dus-border)}",
      ".dus-hmCell:hover{transform:scale(1.12);border-color:var(--dus-fgsubtle)}",
      // 键盘游标格描边：只有「有数据的日子」才弹卡片，落在空日期上若无标记就完全没反馈
      ".dus-hmCur{outline:2px solid var(--dus-c1);outline-offset:1px}",
      ".dus-hmMonths{display:grid;grid-template-columns:repeat(52,minmax(0,1fr));gap:0 2px;margin-top:12px}",
      ".dus-hmMonths span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dus-fgsubtle)}",
      // —— A3 时间范围行（margin-bottom:-6px：20 栅格 gap 视觉收成 14）——
      ".dus-rangeHead{margin-bottom:-6px}",
      // —— A4 趋势折线 ——
      ".dus-chartInner{padding:0 12px 12px}",
      ".dus-legend{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dus-fgsubtle);margin-bottom:12px}",
      ".dus-legendSw{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:-1px;flex:none}",
      // 图例纯展示：不可点击，全部模型恒定列出
      ".dus-legendItem{display:inline-flex;align-items:center;max-width:100%;padding:2px 4px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dus-chartWrap{position:relative}",
      ".dus-axisTxt{font-size:10px;fill:var(--dus-fgfaint)}",
      ".dus-gridLn{stroke:var(--dus-border);stroke-dasharray:3 3}",
      // 悬停卡片（ZCode 同款：标题当日总量 + 分模型行）。v0.2.0 起热力图/环形图共用同一张卡片：
      // 定宽 = TIP_W 的**边框盒**（box-sizing:border-box，否则 padding/border 会让实际宽多 22px、
      // 钳位数学失真）；max-width 收进窄容器。不做「先渲染再量尺寸」的回流补救。
      ".dus-tip{position:absolute;box-sizing:border-box;width:230px;max-width:calc(100% - 16px);pointer-events:none;z-index:5;background:var(--dus-ttbg);border:1px solid var(--dus-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.22);padding:8px 10px;font-size:12px}",
      ".dus-tipH{font-weight:600;margin-bottom:5px}",
      ".dus-tipL{color:var(--dus-fgsubtle);font-variant-numeric:tabular-nums}",
      ".dus-tipR{display:flex;align-items:center;gap:8px;padding:2px 0;color:var(--dus-fgsubtle)}",
      ".dus-tipN{flex:1;min-width:0;padding-right:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dus-tipV{font-family:ui-monospace,\"SF Mono\",\"Cascadia Mono\",Consolas,monospace;font-weight:500;color:var(--dus-fg);font-variant-numeric:tabular-nums}",
      ".dus-tipU{color:var(--dus-fgsubtle);margin-left:4px}",
      ".dus-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}",
      // —— A5 环形图（图例两行式：上行=圆点+完整模型名+右对齐百分比，下行=subtle 短格式 token 数） ——
      ".dus-donutRow{position:relative;display:flex;align-items:center;gap:24px}",
      ".dus-donutBox{position:relative;flex:none}",
      ".dus-donutCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}",
      ".dus-donutT{font-family:ui-monospace,\"SF Mono\",\"Cascadia Mono\",Consolas,monospace;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".dus-donutU{font-size:12px;color:var(--dus-fgsubtle);margin-top:2px}",
      ".dus-mlist{flex:1;min-width:0}",
      ".dus-mrow{padding:9px 2px;border-bottom:1px solid var(--dus-border);min-width:0}",
      ".dus-mrow:last-child{border-bottom:0}",
      ".dus-mrowTop{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dus-msw{width:8px;height:8px;border-radius:50%;flex:none}",
      ".dus-mnm{font-size:13px;color:var(--dus-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dus-mpc{color:var(--dus-fgsubtle);margin-left:auto;flex:none;font-size:13px;font-variant-numeric:tabular-nums}",
      ".dus-mrowSub{margin:3px 0 0 18px;font-size:12.5px;color:var(--dus-fgsubtle)}",
      // —— 页脚刷新 + 三态 + 分块降级行 ——
      ".dus-footRow{display:flex;justify-content:flex-end}",
      ".dus-btnOutline{display:inline-flex;align-items:center;gap:7px;background:transparent;color:var(--dus-fgsubtle);border:1px solid var(--dus-border);border-radius:8px;padding:6px 12px;font-family:inherit;font-size:12.5px;cursor:pointer}",
      ".dus-btnOutline:hover:not(:disabled){color:var(--dus-fg)}",
      ".dus-btnOutline:disabled{opacity:.55;cursor:default}",
      ".dus-stateBox{padding:40px 16px;text-align:center;color:var(--dus-fgsubtle);font-size:13px;line-height:1.6}",
      ".dus-stateTitle{color:var(--dus-fg);font-size:15px;font-weight:500;margin-bottom:6px}",
      ".dus-stateBtn{margin-top:12px}",
      ".dus-errLine{color:var(--dus-fgsubtle);font-size:12px;padding:2px 2px}",
      ".dus-hintLine{color:var(--dus-fgsubtle);font-size:12.5px;padding:2px 2px}",
      // 降级行 + 行内重试（v0.2.0 §6）：不再让用户去找「右下」那个常在视口外的按钮
      ".dus-degrade{display:flex;align-items:center;gap:10px;padding:2px 0}",
      ".dus-degradeBtn{padding:2px 10px;font-size:12px}",
      // 「更新于 HH:MM」：页脚按钮行左端（marginRight:auto 与右按钮组对拉开）
      ".dus-updatedAt{color:var(--dus-fgsubtle);font-size:12px;margin-right:auto;align-self:center;font-variant-numeric:tabular-nums}",
    ].join("");
    const tagId = "@bluechonk/dsh-usage-stats/page.css";
    if (typeof document !== "undefined") {
      const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
      if (existing === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "@bluechonk/dsh-usage-stats";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      } else if (existing.textContent !== css) {
        existing.textContent = css; // 热重载换了样式：原位替换，不留旧标签
      }
    }
    //#endregion

    /** 极简 children 透传的 jsx 工厂，省得逐处手写 children 数组。 */
    function el(type, props) {
      const all = Array.prototype.slice.call(arguments, 2);
      const p = props === null || props === undefined ? {} : Object.assign({}, props);
      if (all.length === 1) p.children = all[0];
      else if (all.length > 1) p.children = all;
      return react_jsx_runtime.jsx(type, p);
    }

    function describeError(error) {
      if (error === null || error === undefined) return "未知错误";
      return error && typeof error.message === "string" && error.message !== "" ? error.message : String(error);
    }

    //#region API（SPEC §5 四条 GET；同源相对路径，webServer 反代同源）
    const API_PREFIX = "/api/dsh-usage-stats";
    /** 统一 GET：网络失败/非 2xx/坏响应体都抛带文案的 Error；调用方全走 allSettled。 */
    async function requestJson(path) {
      let res;
      try {
        res = await fetch(API_PREFIX + path, { cache: "no-store" });
      } catch (error) {
        throw new Error("网络不可达：" + describeError(error));
      }
      if (!res.ok) {
        let text = "HTTP " + res.status;
        try {
          const data = await res.json();
          if (data !== null && typeof data === "object" && typeof data.error === "string" && data.error !== "") text = data.error;
        } catch {
          // 响应体不是 JSON：沿用状态码
        }
        throw new Error(text);
      }
      try {
        return await res.json();
      } catch (error) {
        throw new Error("响应解析失败：" + describeError(error));
      }
    }
    // 服务端 409/503 是英文原文（SPEC路由文案），中文用户直视不友好——已知码位映射中文
    function backfillErrorText(error) {
      const raw = describeError(error);
      if (/already running/i.test(raw)) return "已有一次回填在进行中，稍后再试。";
      if (/read-only mirror/i.test(raw)) return "当前是只读镜像（另一窗口持写锁），接管后会自动补齐，无需手动回填。";
      return raw;
    }
    // 热力图 52 周窗口最多回看 364 天，366（SPEC默认）够覆盖；显式传参防默认漂移。
    const api = {
      summary: () => requestJson("/summary"),
      heatmap: () => requestJson("/heatmap?days=366"),
      trend: (days) => requestJson("/trend?days=" + days),
      models: (days) => requestJson("/models?days=" + days),
      // 回填进度：{running,startedAt,scanned,total,backfilled,records,lostFrames,finishedAt}
      // 回填由宿主装载时自动触发，面板只读进度，不提供手动触发入口。
      backfillStatus: () => requestJson("/backfill/status"),
    };
    //#endregion

    //#region 纯函数（格式化 / 日期 / 热力图 / 曲线 / 环形归并——导出面供直测）
    const DAY_MS = 86400000;

    /** 摘要条/环形中心短格式：≥1e8「x.x 亿」、≥1e4「x.x 万」，去尾 .0。
     *  万档按**缩放后的完整值**再分档：99,999,999 的万档 toFixed(1) 会进位成
     *  「10000.0 万」，改走亿档显示「1 亿」，不再出现「10000 万」。 */
    function fmtCompact(n, tight) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return "0";
      // tight=图表内口径（ZCode：「25.5亿」无空格）；摘要条实证带空格，两档分开
      const gap = tight === true ? "" : " ";
      if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, "") + gap + "亿";
      if (v >= 1e4) {
        const wan = (v / 1e4).toFixed(1);
        if (Number(wan) >= 1e4) return Number((v / 1e8).toFixed(1)) + gap + "亿";
        return wan.replace(/\.0$/, "") + gap + "万";
      }
      return String(Math.round(v));
    }
    /** 图表 tooltip/图例完整千分位（SPEC §6）。 */
    function fmtFull(n) {
      const v = Math.round(Number(n) || 0);
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    /** 时长：「x 天」≥1 天；否则「x 小时 y 分」；不满 1 小时「y 分钟」。 */
    function fmtDuration(ms) {
      const v = Number(ms);
      if (!Number.isFinite(v) || v <= 0) return "0 分钟";
      const d = Math.floor(v / DAY_MS);
      if (d >= 1) return d + " 天";
      const h = Math.floor(v / 3600000);
      const m = Math.floor((v % 3600000) / 60000);
      if (h >= 1) return h + " 小时 " + m + " 分";
      return m + " 分钟";
    }
    function fmtStreak(n) {
      return (Number(n) || 0) + " 天";
    }
    /** 「更新于 HH:MM」时钟（24 小时制）。不进 __pure：导出面由 client.test 快照锁定。 */
    function fmtClock(d) {
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    function dateKey(d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function parseDateKey(s) {
      if (typeof s !== "string") return null;
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
      return m === null ? null : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    // 走 setDate 而非 ms 加减：跨 DST 时区也不漂移（宿主可能在任意时区）。
    function addDays(d, n) {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      x.setDate(x.getDate() + n);
      return x;
    }
    function fmtDayCn(d) {
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }
    function fmtFullDayCn(d) {
      return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    /** 热力五档强度：0 档为零值；其余 ceil(v/max*4) 钳到 [1,4]。 */
    function hmLevel(v, max) {
      if (!(v > 0) || !(max > 0)) return 0;
      return Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
    }

    /** 52 自然周列（周日起始、末周对齐当前周）；days=API 逐日数组，缺失日期按 0。 */
    function hmColumnsOf(days) {
      const byDate = new Map();
      for (const rec of (Array.isArray(days) ? days : [])) {
        if (rec === null || typeof rec !== "object" || typeof rec.date !== "string") continue;
        byDate.set(rec.date, { tokens: Number(rec.tokens) || 0, turns: Number(rec.turns) || 0 });
      }
      const today = new Date();
      const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endSunday = addDays(today0, -today0.getDay()); // 本周周日
      const start = addDays(endSunday, -51 * 7);           // 52 个自然周
      const cols = [];
      for (let w = 0; w < 52; w++) {
        const col = [];
        for (let k = 0; k < 7; k++) {
          const d = addDays(start, w * 7 + k);
          const rec = byDate.get(dateKey(d));
          col.push({ date: d, rec: rec !== undefined, tokens: rec ? rec.tokens : 0, turns: rec ? rec.turns : 0 });
        }
        cols.push(col);
      }
      return cols;
    }

    /** 月份标签：与列同宽的 span 网格行；锚点=周内首个 1 号，否则首个有记录日，否则周日；
     *  相邻同月并 span；超 12 个月从头置空。 */
    function hmMonthLabelsOf(cols) {
      const labels = [];
      for (const col of cols) {
        const anchor = col.find((c) => dateKey(c.date).endsWith("-01")) || col.find((c) => c.rec) || col[0];
        const mk = dateKey(anchor.date).slice(0, 7);
        const last = labels[labels.length - 1];
        if (last && last.key === mk) last.span += 1;
        else labels.push({ key: mk, label: Number(mk.slice(5, 7)) + "月", span: 1 });
      }
      const hidden = Math.max(0, labels.length - 12);
      labels.forEach((l, i) => { if (i < hidden) l.label = ""; });
      return labels;
    }

    /** 热力图渲染定义：每日=逐日格 tooltip；每周/累计=列底对齐色块柱
     *  filledRows=ceil(v/max×7)（钳 [1,7]）+ 整列 tooltip（末列日 + 周合计/累计）。 */
    function hmRenderOf(cols, mode) {
      let dayMax = 0;
      for (const col of cols) for (const c of col) if (c.tokens > dayMax) dayMax = c.tokens;
      const weekVals = cols.map((col) => col.reduce((a, c) => a + c.tokens, 0));
      const weekTurns = cols.map((col) => col.reduce((a, c) => a + c.turns, 0));
      const cumVals = [];
      const cumTurns = [];
      let acc = 0;
      let accT = 0;
      for (let i = 0; i < weekVals.length; i++) {
        acc += weekVals[i];
        accT += weekTurns[i];
        cumVals.push(acc);
        cumTurns.push(accT);
      }
      const isWeekly = mode === "weekly";
      const isTotal = mode === "total";
      const colVals = isWeekly ? weekVals : isTotal ? cumVals : null;
      const colMax = isWeekly ? Math.max(0, ...weekVals) : isTotal ? (cumVals[51] || 0) : 0;
      return cols.map((col, w) => {
        let colTitle = "";
        let defs;
        if (isWeekly || isTotal) {
          const val = colVals[w];
          const turns = isTotal ? cumTurns[w] : weekTurns[w]; // 累计档配累计轮数：两个数口径必须一致
          const filled = val <= 0 || colMax <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil((val / colMax) * 7)));
          const lvl = hmLevel(val, colMax);
          colTitle = fmtFullDayCn(col[6].date) + "\n" + fmtCompact(val, true) + " tokens · " + turns + " 轮消息";
          defs = col.map((c, i) => ({ lvl: i >= 7 - filled ? lvl : 0, has: i >= 7 - filled && val > 0, title: "" }));
        } else {
          defs = col.map((c) => ({
            lvl: hmLevel(c.tokens, dayMax),
            has: c.tokens > 0,
            title: c.rec ? fmtFullDayCn(c.date) + "\n" + fmtCompact(c.tokens, true) + " tokens · " + c.turns + " 轮消息" : "",
          }));
        }
        return { title: colTitle, cells: defs };
      });
    }

    /** 单调三次插值（Fritsch–Carlson，切线幅值限 3× 相邻段斜率）：平滑且绝不过冲。
     *  注：d3-shape 实际用 Steffen 公式，视觉等价但算法不同——此处非「d3 原版」，勿写错口径。不引 d3。 */
    function monotonePath(pts) {
      const n = pts.length;
      if (n < 2) return "";
      if (n === 2) return "M" + pts[0][0] + "," + pts[0][1] + " L" + pts[1][0] + "," + pts[1][1];
      const dx = [];
      const s = [];
      const m = [];
      for (let i = 0; i < n - 1; i++) {
        dx[i] = pts[i + 1][0] - pts[i][0];
        // 重复横坐标（dx<=0）会让斜率变成 ±Infinity，后续 Infinity*0 = NaN 污染整条路径。
        // 置 s=0（该段视作平段）而不是去改 dx：严格递增的数据永不进这条分支，输出逐字不变。
        s[i] = dx[i] > 0 ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0;
      }
      m[0] = s[0];
      m[n - 1] = s[n - 2];
      for (let i = 1; i < n - 1; i++) {
        if (s[i - 1] * s[i] <= 0) { m[i] = 0; continue; }
        m[i] = (s[i - 1] + s[i]) / 2;
        if (Math.abs(m[i]) > 3 * Math.abs(s[i - 1])) m[i] = 3 * s[i - 1];
        if (Math.abs(m[i]) > 3 * Math.abs(s[i])) m[i] = 3 * s[i];
      }
      for (let i = 0; i < n - 1; i++) {
        if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        if (Math.abs(m[i]) > 3 * Math.abs(s[i])) m[i] = 3 * s[i];
        if (Math.abs(m[i + 1]) > 3 * Math.abs(s[i])) m[i + 1] = 3 * s[i];
      }
      let d = "M" + pts[0][0] + "," + pts[0][1];
      for (let i = 0; i < n - 1; i++) {
        d += "C" + (pts[i][0] + dx[i] / 3).toFixed(1) + "," + (pts[i][1] + m[i] * dx[i] / 3).toFixed(1)
          + " " + (pts[i + 1][0] - dx[i] / 3).toFixed(1) + "," + (pts[i + 1][1] - m[i + 1] * dx[i] / 3).toFixed(1)
          + " " + pts[i + 1][0].toFixed(1) + "," + pts[i + 1][1].toFixed(1);
      }
      return d;
    }

    /** 色板取色：6 色循环（--dus-c1..--dus-c6）。 */
    function paletteVar(i) {
      return "var(--dus-c" + (((i % 6) + 6) % 6 + 1) + ")";
    }

    /** 单模型值读取（byModel 缺键/坏值按 0）。 */
    function modelValueOf(point, key) {
      const bm = point !== null && typeof point === "object" && point.byModel !== null && typeof point.byModel === "object"
        ? point.byModel : {};
      const v = Number(bm[key]);
      return Number.isFinite(v) ? v : 0;
    }

    /** 趋势图模型清单：并集键按总量降序（不封顶不归并——归并是环形图明文要求）。 */
    function trendModelRowsOf(points) {
      const sums = new Map();
      for (const p of (Array.isArray(points) ? points : [])) {
        const bm = p !== null && typeof p === "object" && p.byModel !== null && typeof p.byModel === "object" ? p.byModel : {};
        for (const key of Object.keys(bm)) {
          const v = Number(bm[key]);
          if (!Number.isFinite(v)) continue;
          sums.set(key, (sums.get(key) || 0) + v);
        }
      }
      const list = Array.from(sums, ([key, total]) => ({ key, total }))
        .filter((it) => it.total > 0)
        .sort((a, b) => b.total - a.total);
      return list.map((it, i) => ({ key: it.key, color: paletteVar(i) }));
    }

    /** 环形图数据：range=1 从 trend byModel 逐点求和；其余用 /models 响应。
     *  >6 个模型归并「其他模型」（截断在 client，API 返回全量）。 */
    function donutRowsOf(trend, modelsResp, range) {
      let list = null;
      if (range === 1 && trend !== null && Array.isArray(trend.points)) {
        const sums = new Map();
        for (const p of trend.points) {
          const bm = p !== null && typeof p === "object" && p.byModel !== null && typeof p.byModel === "object" ? p.byModel : {};
          for (const key of Object.keys(bm)) {
            const v = Number(bm[key]);
            if (!Number.isFinite(v)) continue;
            sums.set(key, (sums.get(key) || 0) + v);
          }
        }
        list = Array.from(sums, ([key, tokens]) => ({ key, tokens }));
      } else if (modelsResp !== null && Array.isArray(modelsResp.models)) {
        list = modelsResp.models.map((m) => {
          const key = m !== null && typeof m === "object" && typeof m.key === "string" && m.key !== ""
            ? m.key
            : (m.provider !== undefined && m.model !== undefined ? m.provider + "/" + m.model : String(m));
          return { key, tokens: Number(m.tokens) || 0 };
        });
      }
      if (list === null) return null;
      const positive = list
        .map((it) => ({ key: it.key, tokens: Math.max(0, it.tokens) })) // replace 负增量残值不进图
        .filter((it) => it.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens);
      const total = positive.reduce((a, it) => a + it.tokens, 0);
      const rows = positive.slice(0, 6).map((it, i) => ({ key: it.key, tokens: it.tokens, color: paletteVar(i) }));
      // 归并行的被并入名单带着走（v0.2.0 §6）：图例行 hover 时能回答「其他」到底并了谁
      const restRows = positive.slice(6);
      const rest = restRows.reduce((a, it) => a + it.tokens, 0);
      if (rest > 0) rows.push({ key: "其他模型", tokens: rest, color: "var(--dus-fgfaint)", merged: restRows.map((it) => it.key) });
      return { rows, total };
    }

    /** 环形扇区路径（pad 已由调用方扣进 a0/a1）。 */
    function donutArcPath(cx, cy, rO, rI, a0, a1) {
      const p = (r, a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
      const large = a1 - a0 > 180 ? 1 : 0;
      const x0y0 = p(rO, a0);
      const x1y1 = p(rO, a1);
      const x2y2 = p(rI, a1);
      const x3y3 = p(rI, a0);
      const f = (n) => n.toFixed(2);
      return "M" + f(x0y0[0]) + "," + f(x0y0[1])
        + " A" + rO + "," + rO + " 0 " + large + " 1 " + f(x1y1[0]) + "," + f(x1y1[1])
        + " L" + f(x2y2[0]) + "," + f(x2y2[1])
        + " A" + rI + "," + rI + " 0 " + large + " 0 " + f(x3y3[0]) + "," + f(x3y3[1]) + " Z";
    }
    //#endregion

    //#region v0.2.0 新增纯函数（SPEC §6；只放算术与转移表，副作用一律留在组件里）
    /** 悬停卡片尺寸（SPEC §6）：定宽让定位数学可精确钳位；TIP_H 只用于纵向钳位的保守估计。 */
    const TIP_W = 230;
    const TIP_H = 120;
    /** 卡片高度的保守估算（标题 + 每行 17px + 内衬），只给纵向钳位用；行数可变的趋势卡片用它。 */
    const tipHeightOf = (rowCount) => 40 + 17 * Math.max(1, Math.floor(Number(rowCount) || 0));

    /** phase 转移（§6）：full 拍（初始 load / 用户显式刷新）全权；静默拍**单调**——
     *  ready 恒保持，非 ready 只允许升到 ready，其余一律 no-op。
     *  目的：静默拍既能把「空态」拉出来（治 S4），又绝不会把有数据的面板打成空态/错误态。 */
    function phaseAfterTick(prev, next, silent) {
      if (silent !== true) return next;
      if (prev === "ready") return "ready";
      if (next === "ready") return "ready";
      return prev;
    }

    /** 摘要条六格（§6）：值=短格式、标签、悬停 title（精确值 + 口径说明）。 */
    function summaryCellsOf(summary) {
      const s = summary !== null && typeof summary === "object" ? summary : {};
      const total = Number(s.totalTokens) || 0;
      const peakObj = s.peakDay !== null && typeof s.peakDay === "object" ? s.peakDay : null;
      const peak = peakObj === null ? 0 : Number(peakObj.tokens) || 0;
      const peakD = peakObj !== null && typeof peakObj.date === "string" ? parseDateKey(peakObj.date) : null;
      const sinceD = typeof s.since === "string" && s.since !== "" ? parseDateKey(s.since) : null;
      // 缓存命中率：后端给的是百分比数值；缺字段（老数据/镜像）时按「—」处理而不是 0%
      const rateRaw = s.cacheHitRate === null || s.cacheHitRate === undefined ? null : Number(s.cacheHitRate);
      const rate = rateRaw !== null && Number.isFinite(rateRaw) ? rateRaw : null;
      const cacheRead = Number(s.cacheReadTokens) || 0;
      const uncached = Number(s.uncachedInputTokens) || 0;
      return [
        { key: "total", value: fmtCompact(total), label: "累计 Token 数",
          title: "累计 " + fmtFull(total) + " Token" + (sinceD === null ? "" : "，自 " + dateKey(sinceD) + " 起") },
        { key: "peak", value: fmtCompact(peak), label: "峰值 Token 数",
          title: peak > 0 && peakD !== null ? "单日峰值 " + fmtFull(peak) + " Token（" + fmtDayCn(peakD) + "）" : "暂无用量" },
        { key: "cache", value: rate === null ? "—" : rate.toFixed(1) + "%", label: "缓存命中率",
          title: rate === null
            ? "暂无输入用量，无法计算缓存命中率"
            : "缓存命中 " + fmtFull(cacheRead) + " Token / 输入合计 " + fmtFull(cacheRead + uncached) + " Token" },
        { key: "longest", value: fmtDuration(s.longestChatMs), label: "最长聊天时长",
          title: "按（会话, 日）分桶取最长一次，跨日会话按日截断" },
        { key: "cur", value: fmtStreak(s.currentStreakDays), label: "当前连续天数",
          title: "每天有用量算一天；今天还没有用量时从昨天往回数" },
        { key: "max", value: fmtStreak(s.longestStreakDays), label: "最长连续天数",
          title: "历史最长的连续有用量天数" },
      ];
    }

    /** 悬停/游标卡片定位（§6）：锚点两侧择优 + 两轴钳位到容器内——任何 tipW/tipH 都不溢出。
     *  卡片定宽（TIP_W）让数学精确；缺尺寸/坏输入一律按容器能容下处理，绝不产出 NaN。 */
    function tipPlacementOf(anchorX, anchorY, containerW, containerH, tipW, tipH) {
      const margin = 8;
      const gap = 14;
      const w = Number(tipW) > 0 ? Number(tipW) : TIP_W;
      const h = Number(tipH) > 0 ? Number(tipH) : TIP_H;
      const cw = Number(containerW) > 0 ? Number(containerW) : w + margin * 2;
      const ch = Number(containerH) > 0 ? Number(containerH) : h + margin * 2;
      const ax = Number.isFinite(Number(anchorX)) ? Number(anchorX) : 0;
      const ay = Number.isFinite(Number(anchorY)) ? Number(anchorY) : 0;
      let left = ax + gap;
      if (left + w > cw - margin) left = ax - gap - w;
      left = Math.min(Math.max(left, margin), Math.max(margin, cw - w - margin));
      let top = ay - Math.round(h / 2);
      top = Math.min(Math.max(top, margin), Math.max(margin, ch - h - margin));
      return { left: Math.round(left), top: Math.round(top) };
    }

    /** 趋势卡片的数据行（§6）：0 用量模型行不进卡片（避免误导为有效用量）。
     *  数值用万/亿简写——完整千分位在六位数以上读不出量级。 */
    function tipRowsOf(point, modelRows) {
      const rows = [];
      for (const m of (Array.isArray(modelRows) ? modelRows : [])) {
        const v = modelValueOf(point, m.key);
        if (!(v > 0)) continue;
        rows.push({ key: m.key, color: m.color, value: fmtCompact(v, true) });
      }
      return rows;
    }

    /** 占比文案（§6）：≥10% 取整、<10% 一位小数（照 ZCode 界面口径）；零值/无效一律「0%」。 */
    function pctTextOf(tokens, total) {
      const t = Number(total);
      const n = Number(tokens) || 0;
      if (!(t > 0) || n <= 0) return "0%";
      const v = (n / t) * 100;
      return (v >= 10 ? String(Math.round(v)) : v.toFixed(1)) + "%";
    }

    /** 环形卡片文案行：token 简写 + 占比（无模型行——环形图没有一个「点」的 byModel）。 */
    function donutTipTextOf(row, total) {
      const tokens = Math.max(0, Number(row !== null && typeof row === "object" ? row.tokens : 0) || 0);
      return fmtCompact(tokens, true) + " Token · " + pctTextOf(tokens, total);
    }

    /** 静默拍要不要补拉热力图（§6）：只在总量或「今天」变了才拉。
     *  回应「历史日档每次请求都要同步读盘」的真实成本——空闲时零额外请求。 */
    function needHeatmapRefreshOf(prev, next) {
      if (prev === null || prev === undefined || next === null || next === undefined) return false;
      return (Number(prev.totalTokens) || 0) !== (Number(next.totalTokens) || 0)
        || (prev.today === undefined ? null : prev.today) !== (next.today === undefined ? null : next.today);
    }

    /** 键盘游标步进（§6）：← → 走 stride（热力图=一周 7 格）、↑ ↓ 走 1 格，Home/End 到两端。
     *  非法键返回原游标；越界一律钳回 [0, len-1]。 */
    function cursorStepOf(cursor, key, length, stride) {
      const len = Math.max(0, Math.floor(Number(length) || 0));
      if (len === 0) return 0;
      const step = Math.max(1, Math.floor(Number(stride) || 1));
      let cur = Math.floor(Number(cursor));
      if (!Number.isFinite(cur)) cur = 0;
      cur = Math.min(Math.max(cur, 0), len - 1);
      let next = cur;
      if (key === "ArrowLeft") next = cur - step;
      else if (key === "ArrowRight") next = cur + step;
      else if (key === "ArrowUp") next = cur - 1;
      else if (key === "ArrowDown") next = cur + 1;
      else if (key === "Home") next = 0;
      else if (key === "End") next = len - 1;
      else return cur;
      return Math.min(Math.max(next, 0), len - 1);
    }

    /** 回填 UI 映射（§6）：纯展示映射——「要不要继续轮询 / 跑完要不要刷新」
     *  这类副作用留在组件里，不进纯函数。回填由宿主自动触发，面板不提供手动按钮，
     *  这里只产出空态/跟踪态文案。 */
    function backfillUiOf(state) {
      const s = state !== null && typeof state === "object" ? state : {};
      const tracking = s.tracking === true;
      const scannedRaw = Number(s.scanned);
      const total = Math.floor(Number(s.total) || 0);
      const hasProgress = Number.isFinite(scannedRaw) && total > 0;
      const progress = "已扫 " + Math.max(0, Math.round(scannedRaw)) + "/" + total + " 会话";
      if (!tracking) {
        return {
          emptyTitle: "暂无使用数据",
          emptyDesc: "开始对话后这里会显示 Token 活动与模型用量；若刚装上插件，历史会话会在后台自动补进来。",
        };
      }
      return {
        emptyTitle: "正在回填历史会话…",
        emptyDesc: hasProgress ? progress + "，完成后这里会自动显示统计。" : "历史多时需要几分钟，完成后这里会自动显示统计。",
      };
    }
    //#endregion

    //#region API 响应形状哨兵（坏形状=显式按失败降级，不静默当空数据）
    function validOf(key, value) {
      if (value === null || typeof value !== "object") return false;
      if (key === "summary") return Number.isFinite(Number(value.totalTokens));
      if (key === "heatmap") return Array.isArray(value.days);
      if (key === "trend") return Array.isArray(value.points);
      if (key === "models") return Array.isArray(value.models);
      return false;
    }
    //#endregion

    //#region 通用小部件
    /** 胶囊 Tab（h-7 rounded-full，激活项反色；样式见 .dus-pills/.dus-pill）。
     *  选中态同时给语义（aria-pressed，SPEC §6）——只靠背景色的选中态读屏用户听不出来。 */
    function Pills(props) {
      return el("div", { className: "dus-pills" },
        props.options.map((o) => el("button", {
          key: String(o.value),
          type: "button",
          className: o.value === props.value ? "dus-pill dus-pillOn" : "dus-pill",
          "aria-pressed": o.value === props.value,
          onClick: () => props.onChange(o.value),
        }, o.label)),
      );
    }

    /** 三态盒（加载中… / 暂无使用数据 / 加载失败+重试）。 */
    function StateBox(props) {
      return el("div", { className: "dus-stateBox" },
        props.title !== undefined ? el("div", { className: "dus-stateTitle" }, props.title) : null,
        props.desc,
        props.onRetry !== undefined ? el("div", { className: "dus-stateBtn" },
          el("button", { type: "button", className: "dus-btnOutline", onClick: props.onRetry }, "重试"),
        ) : null,
      );
    }

    /** 共用的悬停/游标卡片（§6）：热力图、趋势图、环形图同一张——
     *  标题 + 纯文本行（lines）+ 模型行（rows，带色点与「tokens」单位）。 */
    function TipCard(props) {
      const rows = Array.isArray(props.rows) ? props.rows : [];
      const lines = Array.isArray(props.lines) ? props.lines : [];
      return el("div", { className: "dus-tip", style: { left: props.left + "px", top: props.top + "px" } },
        props.title === null || props.title === undefined ? null : el("div", { className: "dus-tipH" }, props.title),
        rows.map((r) => el("div", { key: r.key, className: "dus-tipR" },
          el("i", { className: "dus-dot", style: { background: r.color } }),
          el("span", { className: "dus-tipN", title: r.key }, r.key),
          el("span", { className: "dus-tipV" }, r.value),
          el("span", { className: "dus-tipU" }, "tokens"),
        )),
        lines.map((text, i) => el("div", { key: "l" + i, className: "dus-tipL" }, text)),
      );
    }

    /** 卡片级降级行（§6 配套 / §6）：文案 + 行内「重试」——
     *  旧文案让人去点「右下刷新」，而那个按钮常在视口外且窄窗会换位。 */
    function DegradeLine(props) {
      return el("div", { className: "dus-degrade" },
        el("span", { className: "dus-errLine" }, props.text),
        el("button", { type: "button", className: "dus-btnOutline dus-degradeBtn", onClick: props.onRetry }, "重试"),
      );
    }
    //#endregion

    //#region A1 五格摘要条（§6：格子带悬停说明——精确值 + 峰值日期 + 累计起点 + 口径）
    function SummaryStrip(props) {
      const cells = summaryCellsOf(props.summary);
      return el("div", { className: "dus-strip" },
        cells.map((c) => el("div", { key: c.key, className: "dus-cell", title: c.title },
          el("div", { className: "dus-cellV" }, c.value),
          el("div", { className: "dus-cellK" }, c.label))),
      );
    }
    //#endregion

    //#region A2 Token 活动热力图（每日/每周/累计三档；三档切换=ZCode 自带功能，必须保留）
    const HM_MODES = [
      { value: "daily", label: "每日" },
      { value: "weekly", label: "每周" },
      { value: "total", label: "累计" },
    ];
    const HM_CELLS = 52 * 7; // 52 周 × 7 天：键盘游标的线性长度（SPEC §6）
    // 图表键盘导航：只认这六个键，认到就接管（preventDefault + 落游标），其余键（含 Tab）一律放行。
    const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    // 聚焦后游标默认落「今天」那格（末列 51 × 7 + 星期几）——否则第一下方向键要从一年前起步，
    // 还容易在边界上看起来像没反应。
    const todayFlatOf = () => 51 * 7 + new Date().getDay();

    function HeatmapCard(props) {
      const cols = react.useMemo(() => hmColumnsOf(props.days), [props.days]);
      const render = react.useMemo(() => hmRenderOf(cols, props.mode), [cols, props.mode]);
      const months = react.useMemo(() => hmMonthLabelsOf(cols), [cols]);
      const [hover, setHover] = react.useState(null);   // {flat,x,y,cw,ch}
      // 键盘游标只存 flat 索引：像素锚点在渲染时现算，窗口缩放/跨天/换档后不会指向脏位置
      const [cursor, setCursor] = react.useState(null);
      const wrapRef = react.useRef(null);
      // 「有用量的天数」从原始逐日数组算，与渲染档位解耦——每周/累计档的 has 是「柱里被填的格数」，
      // 拿它当天数会读到 7 倍
      const usedDays = react.useMemo(() => (Array.isArray(props.days) ? props.days : [])
        .filter((d) => d !== null && typeof d === "object" && Number(d.tokens) > 0).length, [props.days]);
      // 锚点一律从真实 DOM rect 取：52 列 1fr 等分下「按格子尺寸推算」会因 gap/取整漂移
      const anchorOfFlat = (flat) => {
        const wrap = wrapRef.current;
        if (wrap === null) return null;
        const node = wrap.querySelector('[data-hm="' + flat + '"]');
        if (node === null) return null;
        const cell = node.getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        return { flat, x: cell.left - box.left + cell.width / 2, y: cell.top - box.top + cell.height / 2, cw: box.width, ch: box.height };
      };
      const onCellEnter = (flat) => (e) => {
        const wrap = wrapRef.current;
        if (wrap === null) return;
        const cell = e.currentTarget.getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        setHover({ flat, x: cell.left - box.left + cell.width / 2, y: cell.top - box.top + cell.height / 2, cw: box.width, ch: box.height });
      };
      const onKeyDown = (e) => {
        if (NAV_KEYS.indexOf(e.key) === -1) return; // 其它键（含 Tab）放行
        const base = cursor !== null ? cursor : hover !== null ? hover.flat : todayFlatOf();
        const next = cursorStepOf(base, e.key, HM_CELLS, 7);
        if (anchorOfFlat(next) === null) return; // 网格未渲染时不动
        e.preventDefault();
        setCursor(next);
      };
      const shown = cursor !== null ? anchorOfFlat(cursor) : hover;
      let tipProps = null;
      if (shown !== null) {
        const w = Math.floor(shown.flat / 7);
        const k = shown.flat % 7;
        const colDef = render[w];
        if (colDef !== undefined && colDef.cells[k] !== undefined) {
          // 每周/累计档整列一条 tooltip（colDef.title）；每日档逐格（cell.title，缺勤日为空=不弹）
          const text = colDef.title !== "" ? colDef.title : colDef.cells[k].title;          if (text !== "") {
            const parts = text.split("\n");
            const pos = tipPlacementOf(shown.x, shown.y, shown.cw, shown.ch, TIP_W, TIP_H);
            tipProps = { left: pos.left, top: pos.top, title: parts[0], lines: parts.slice(1) };
          }
        }
      }
      return el("div", { className: "dus-card dus-cardTight" },
        el("div", { className: "dus-secHead" },
          el("div", { className: "dus-secTitle" }, "Token 活动"),
          el(Pills, { options: HM_MODES, value: props.mode, onChange: props.onMode }),
        ),
        // 有数据但本轮更新失败：显式说明显示的是旧值（§6 按需刷新的残留面）
        props.stale === true
          ? el("div", { className: "dus-hintLine", style: { marginBottom: 8 } }, "活动数据更新失败，显示为上次数据。")
          : null,
        el("div", {
          className: "dus-hmWrap",
          ref: wrapRef,
          tabIndex: 0,
          role: "img",
          "aria-label": "Token 活动热力图，最近 52 周，共 " + usedDays + " 天有用量。用 ← → 切换周、↑ ↓ 切换日。",
          onKeyDown,
          onBlur: () => setCursor(null),
          onMouseLeave: () => setHover(null),
        },
          el("div", { className: "dus-hmGrid" },
            render.map((colDef, w) => el("div", { key: w, className: "dus-hmCol" },
              colDef.cells.map((cd, k) => el("i", {
                key: k,
                "data-hm": w * 7 + k,
                className: (cd.has ? "dus-hmCell dus-hmCellUsed" : "dus-hmCell")
                  + (cursor !== null && cursor === w * 7 + k ? " dus-hmCur" : ""),
                style: { background: "var(--dus-hm" + cd.lvl + ")" },
                onMouseEnter: onCellEnter(w * 7 + k),
              })),
            )),
          ),
          el("div", { className: "dus-hmMonths" },
            months.map((l, i) => el("span", { key: i, style: { gridColumn: "span " + l.span } }, l.label)),
          ),
          tipProps === null ? null : el(TipCard, tipProps),
        ),
      );
    }
    //#endregion

    //#region A4 每日 Token 趋势折线（手写 monotone；Y 域=[0,单模型单日峰值]）
    // 视箱与边距：margin {top:8,right:24,left:24,bottom:26}（首尾日期文本安全区）。
    const TREND_W = 828;
    const TREND_H = 240;
    const TREND_L = 24;
    const TREND_R = 24;
    const TREND_T = 8;
    const TREND_B = 26;

    function TrendCard(props) {
      const trend = props.trend;
      const granularity = trend !== null && trend.granularity === "hour" ? "hour" : "day";
      const points = trend !== null && Array.isArray(trend.points) ? trend.points : [];
      const modelRows = react.useMemo(() => trendModelRowsOf(points), [trend]);
      const [hover, setHover] = react.useState(null);         // {idx,x,y,cw,ch}
      const [cursor, setCursor] = react.useState(null);       // 键盘游标=点索引（锚点渲染时现算）
      const wrapRef = react.useRef(null);
      const n = points.length;
      const span = Math.max(1, n - 1);
      // Y 域 [0, 单模型单日峰值]——独立折线不是堆叠图，不能拿日总量当域。
      let mx = 1;
      for (const p of points) {
        for (const row of modelRows) {
          const v = modelValueOf(p, row.key);
          if (v > mx) mx = v;
        }
      }
      const X = (i) => TREND_L + (i * (TREND_W - TREND_L - TREND_R)) / span;
      const Y = (v) => TREND_T + (1 - v / mx) * (TREND_H - TREND_T - TREND_B);
      // 图例只作查看：全部模型恒定展示，不提供隐藏/恢复交互
      const visibleRows = modelRows;
      const anchorOfIdx = (idx) => {
        const wrap = wrapRef.current;
        if (wrap === null) return null;
        const box = wrap.getBoundingClientRect();
        let py = TREND_H / 2;
        for (const m of visibleRows) {
          const v = modelValueOf(points[idx], m.key);
          if (v > 0) { py = (Y(v) * box.height) / TREND_H; break; }
        }
        return { idx, x: (X(idx) * box.width) / TREND_W, y: py, cw: box.width, ch: box.height };
      };
      const handleMove = (e) => {
        const wrap = wrapRef.current;
        if (wrap === null || n === 0) return;
        const box = wrap.getBoundingClientRect();
        const vx = ((e.clientX - box.left) * TREND_W) / box.width;
        let idx = Math.round((vx - TREND_L) / ((TREND_W - TREND_L - TREND_R) / span));
        idx = Math.max(0, Math.min(n - 1, idx));
        const anchor = anchorOfIdx(idx);
        if (anchor === null) return;
        setHover({ ...anchor, x: e.clientX - box.left }); // 横向跟鼠标、纵向跟该点最高的一条可见线
      };
      const onKeyDown = (e) => {
        if (NAV_KEYS.indexOf(e.key) === -1) return; // 其它键（含 Tab）放行
        const base = cursor !== null ? cursor : hover !== null ? hover.idx : n - 1;
        const next = cursorStepOf(base, e.key, n, 1);
        if (anchorOfIdx(next) === null) return; // 图表未渲染时不动
        e.preventDefault();
        setCursor(next);
      };

      if (n === 0) {
        return el("div", { className: "dus-card" },
          el("div", { className: "dus-secTitle", style: { marginBottom: 12 } }, "每日 Token 趋势图"),
          props.err === true
            ? el(DegradeLine, { text: "趋势数据加载失败，请重试。", onRetry: props.onRetry })
            : el("div", { className: "dus-hintLine" }, "暂无趋势数据。"),
        );
      }

      // ZCode shouldShowDailyChartAxisLabel：≤14 点全标，否则首、尾、每 5 个。
      const showLbl = (i) => n <= 14 || i === 0 || i === n - 1 || i % (n > 45 ? 7 : 5) === 0;
      const labelOf = (p) => {
        if (granularity === "hour") return typeof p.label === "string" ? p.label : "";
        const d = parseDateKey(p.date);
        return d === null ? String(p.date === undefined ? "" : p.date) : fmtDayCn(d);
      };
      const todayLabel = granularity === "hour" ? fmtDayCn(new Date()) : "";
      const shown = cursor !== null ? anchorOfIdx(cursor) : hover;
      const hoverPoint = shown !== null && points[shown.idx] !== undefined ? points[shown.idx] : null;
      const tipTitle = (p) => {
        const total = Number(p.total) || 0;
        if (granularity === "hour") return todayLabel + " " + (typeof p.label === "string" ? p.label : "") + " - " + fmtCompact(total, true) + " tokens";
        const d = parseDateKey(p.date);
        return (d === null ? "" : fmtDayCn(d)) + " - " + fmtCompact(total, true) + " tokens";
      };
      // 卡片行数封顶 8：趋势线不封顶模型数，十几个模型的行逐条列出来既读不动也放不下
      const allRows = hoverPoint === null ? [] : tipRowsOf(hoverPoint, visibleRows);
      const shownRows = allRows.slice(0, 8);
      const restCount = allRows.length - shownRows.length;
      let tipProps = null;
      if (shown !== null && hoverPoint !== null) {
        const lines = restCount > 0 ? ["另有 " + restCount + " 个模型未列出"] : [];
        const pos = tipPlacementOf(shown.x, shown.y, shown.cw, shown.ch, TIP_W, tipHeightOf(shownRows.length + lines.length));
        tipProps = { left: pos.left, top: pos.top, title: tipTitle(hoverPoint), rows: shownRows, lines };
      }
      const rangeLabel = typeof props.rangeLabel === "string" ? props.rangeLabel : "";
      const wrapProps = {
        className: "dus-chartWrap",
        ref: wrapRef,
        tabIndex: 0,
        role: "img",
        "aria-label": "每日 Token 趋势图，" + rangeLabel + "，共 " + n + " 个数据点。用 ← → 移动游标。",
        onMouseMove: handleMove,
        onMouseLeave: () => setHover(null),
        onKeyDown,
        onBlur: () => setCursor(null),
      };

      return el("div", { className: "dus-card" },
        el("div", { className: "dus-secTitle", style: { marginBottom: 12 } }, "每日 Token 趋势图"),
        el("div", { className: "dus-chartInner" },
          // 图例：纯展示，全部模型恒定列出，不可点击隐藏
          el("div", { className: "dus-legend" },
            modelRows.map((m) => el("span", {
              key: m.key,
              className: "dus-legendItem",
              title: m.key,
            },
              el("i", { className: "dus-legendSw", style: { background: m.color } }),
              m.key,
            )),
          ),
          el("div", wrapProps,
              el("svg", { width: "100%", viewBox: "0 0 " + TREND_W + " " + TREND_H, style: { display: "block" } },
                // 横向虚线网格 4 条（3 3）；无 Y 轴、无竖线、无 hover 参考线（SPEC明文）。
                [0, 1, 2, 3].map((g) => el("line", {
                  key: "g" + g,
                  className: "dus-gridLn",
                  x1: TREND_L,
                  y1: TREND_T + (g * (TREND_H - TREND_T - TREND_B)) / 3,
                  x2: TREND_W - TREND_R,
                  y2: TREND_T + (g * (TREND_H - TREND_T - TREND_B)) / 3,
                })),
                points.map((p, i) => (showLbl(i) ? el("text", {
                  key: "x" + i,
                  className: "dus-axisTxt",
                  x: X(i),
                  y: TREND_H - 8,
                  textAnchor: "middle",
                }, labelOf(p)) : null)),
                visibleRows.map((m) => el("path", {
                  key: m.key,
                  d: monotonePath(points.map((p, i) => [X(i), Y(modelValueOf(p, m.key))])),
                  fill: "none",
                  style: { stroke: m.color },
                  strokeWidth: 2,
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                })),
                // 悬停/游标圆点（仅激活时出现；静态图无数据点圆）。0 值模型也画在底线上。
                hoverPoint !== null ? visibleRows.map((m) => el("circle", {
                  key: "d-" + m.key,
                  cx: X(shown.idx),
                  cy: Y(modelValueOf(hoverPoint, m.key)),
                  r: 4,
                  fill: m.color,
                  style: { stroke: "var(--dus-ttbg)" },
                  strokeWidth: 2,
                })) : null,
              ),
              tipProps === null ? null : el(TipCard, tipProps),
            ),
        ),
      );
    }
    //#endregion

    //#region A5 模型用量环形图（图例两行式；尺寸 240 系放大对齐）
    const DONUT_SIZE = 240;
    const DONUT_R_OUT = 96;
    const DONUT_R_IN = 63.4;
    const DONUT_PAD = 2; // paddingAngle 2°
    const DONUT_MERGE = 6; // 超 6 个模型归并「其他模型」

    function DonutCard(props) {
      const data = donutRowsOf(props.trend, props.modelsResp, props.range);
      const [tip, setTip] = react.useState(null); // {key,x,y,cw,ch}
      const rowRef = react.useRef(null);
      if (data === null || data.total <= 0 || data.rows.length === 0) {
        return el("div", { className: "dus-card" },
          el("div", { className: "dus-secHead" }, el("div", { className: "dus-secTitle" }, "模型用量")),
          props.err === true
            ? el(DegradeLine, { text: "模型用量加载失败，请重试。", onRetry: props.onRetry })
            : el("div", { className: "dus-hintLine" }, "暂无模型用量。"),
        );
      }
      const cx = DONUT_SIZE / 2;
      const cy = DONUT_SIZE / 2;
      let ang = -90;
      const arcs = [];
      for (const it of data.rows) {
        const sweep = (it.tokens / data.total) * 360;
        // 扇区过窄（sweep≤pad）扣不掉两侧内衬会画出倒翻路径：跳过绘制，图例行仍在。
        if (sweep > DONUT_PAD) {
          arcs.push({ it, a0: ang + DONUT_PAD / 2, a1: ang + sweep - DONUT_PAD / 2 });
        }
        ang += sweep;
      }
      // 悬停卡片（§6）：锚点=鼠标在整行内的位置——240px 的环形盒放不下 230 宽的卡片，
      // 定位容器必须是整行（.dus-donutRow 已 position:relative），配合钳位才不溢出。
      const showTip = (key) => (e) => {
        const row = rowRef.current;
        if (row === null) return;
        const box = row.getBoundingClientRect();
        setTip({ key, x: e.clientX - box.left, y: e.clientY - box.top, cw: box.width, ch: box.height });
      };
      const scopeText = props.range === 1 ? "今日" : "近 " + props.range + " 日";
      let tipProps = null;
      if (tip !== null) {
        const hit = data.rows.filter((r) => r.key === tip.key)[0];
        if (hit !== undefined) {
          const pos = tipPlacementOf(tip.x, tip.y, tip.cw, tip.ch, TIP_W, TIP_H);
          tipProps = { left: pos.left, top: pos.top, title: hit.key, lines: [donutTipTextOf(hit, data.total), scopeText] };
        }
      }
      const top = data.rows[0];
      return el("div", { className: "dus-card" },
        el("div", { className: "dus-secHead" }, el("div", { className: "dus-secTitle" }, "模型用量")),
        el("div", { className: "dus-donutRow", ref: rowRef, onMouseLeave: () => setTip(null) },
          el("div", { className: "dus-donutBox" },
            el("svg", {
              width: DONUT_SIZE, height: DONUT_SIZE, viewBox: "0 0 " + DONUT_SIZE + " " + DONUT_SIZE,
              role: "img",
              "aria-label": "模型用量环形图，共 " + data.rows.length + " 个模型，" + top.key + " 占比最高（" + pctTextOf(top.tokens, data.total) + "）。",
            },
              arcs.map((a) => el("path", {
                key: a.it.key,
                d: donutArcPath(cx, cy, DONUT_R_OUT, DONUT_R_IN, a.a0, a.a1),
                fill: a.it.color,
                onMouseEnter: showTip(a.it.key),
              })),
            ),
            el("div", { className: "dus-donutCenter" },
              el("div", { className: "dus-donutT" }, fmtCompact(data.total, true)),
              el("div", { className: "dus-donutU" }, "tokens"),
            ),
          ),
          // 图例两行式：上行=圆点+完整模型名+右对齐百分比；下行=subtle 短格式 token 数（缩进对齐名字）
          el("div", { className: "dus-mlist" },
            data.rows.map((it) => el("div", {
              key: it.key, className: "dus-mrow", onMouseEnter: showTip(it.key),
              title: it.merged !== undefined ? "包含：" + it.merged.join("、") : it.key,
            },
              el("div", { className: "dus-mrowTop" },
                el("span", { className: "dus-msw", style: { background: it.color } }),
                el("span", { className: "dus-mnm", title: it.key }, it.key),
                el("span", { className: "dus-mpc" }, pctTextOf(it.tokens, data.total)),
              ),
              el("div", { className: "dus-mrowSub", title: fmtFull(it.tokens) + " Token" }, fmtCompact(it.tokens, true) + " tokens"),
            )),
          ),
          // 卡片挂在**这一行**里（.dus-donutRow 的 position:relative 因此真正生效）：
          // 挂到卡片层会让坐标基准（行）与定位祖先（卡片）错位，纵向恒定偏一个标题高
          tipProps === null ? null : el(TipCard, tipProps),
        ),
      );
    }
    //#endregion

    //#region 分区组件（三态 + 六块 UI 装配）
    // 只暴露「近 7 日 / 近 30 日」两档（对齐产品设计稿）；range=1 的底层分支保留但不在 UI 暴露。
    const RANGE_MODES = [
      { value: 7, label: "近 7 日" },
      { value: 30, label: "近 30 日" },
    ];
    const REFRESH_ICON = el("svg", {
      key: "icon", width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round",
    },
      el("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
      el("polyline", { points: "21 3 21 9 15 9" }),
    );

    function UsageStatsSection() {
      const [phase, setPhase] = react.useState("loading"); // loading | ready | empty | error
      const [summary, setSummary] = react.useState(null);
      const [hmDays, setHmDays] = react.useState(null);
      const [hmMode, setHmMode] = react.useState("daily");
      const [range, setRange] = react.useState(30); // 默认近 30 日
      const [trend, setTrend] = react.useState(null);
      const [modelsResp, setModelsResp] = react.useState(null);
      const [blockErr, setBlockErr] = react.useState({});
      const [refreshing, setRefreshing] = react.useState(false);
      const [updatedAt, setUpdatedAt] = react.useState(null); // 「更新于 HH:MM」（§6 全 ok 才推进）
      const [staleTick, setStaleTick] = react.useState(false); // 最近一拍有路失败：时间戳旁给可见标注
      // 回填跟踪（§6）：tracking=本面板正在跟一次回填（挂载发现 or 手动发起）；
      // message=成果/失败/兜底文案；status=实时进度（供「已扫 X/Y」）
      const [backfill, setBackfill] = react.useState({ tracking: false, status: null, message: null });
      const seqRef = react.useRef(0);
      const mountedRef = react.useRef(false);
      const backfillTimerRef = react.useRef(null);   // 单一 ticker 的句柄（挂载/手动共用）
      const backfillActiveRef = react.useRef(false); // 本面板是否已有一条在跟的链（唯一判据，只在 stop 里清）
      const backfillFailRef = react.useRef(0);       // status 连续失败计数（跨 tick）
      const sawRunningRef = react.useRef(false);     // 是否观察到过 running=true（决定跑完要不要刷新）
      const rangeRef = react.useRef(30);             // 当前 range：给轮询/回填后刷新用，避开 stale 闭包
      const inflightRef = react.useRef(0);           // 非静默在飞计数（§6：刷新闩与 seq 解耦）
      const lastSumRef = react.useRef(null);         // {totalTokens, today}：静默拍按需刷热力图的判定输入
      const stopBackfillTicker = () => {
        backfillActiveRef.current = false; // 唯一清点：链结束/放弃/卸载都走这里
        if (backfillTimerRef.current !== null) {
          clearTimeout(backfillTimerRef.current);
          backfillTimerRef.current = null;
        }
      };
      react.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          // safeSet 只兜 state 写入；定时器链要显式清，否则卸载后轮询空转到回填结束
          stopBackfillTicker();
        };
      }, []);
      const safeSet = react.useCallback((fn) => {
        if (mountedRef.current) fn();
      }, []);

      // runLoad：四路请求互不拖垮（逐路落 state，单路失败只亮自己的降级行）；
      // seq 递增取最新，过期响应整包丢弃（reload 防重入）。
      // 三档口径：full=四路全拉；silent（60s 拍）=summary + 当前 range 的 trend +（range≠1 时）models，
      // 外加「总量/今天变了才补」的 heatmap；chartsOnly（换档）=trend +（range≠1 时）models。
      // 刷新闩走 in-flight 计数（§6）：被新拍顶掉的旧拍也一定在 finally 复位，不再卡「刷新中…」。
      const runLoad = react.useCallback(async (rangeArg, opts) => {
        const chartsOnly = opts !== null && opts !== undefined && opts.chartsOnly === true;
        const initial = opts !== null && opts !== undefined && opts.initial === true;
        const silent = opts !== null && opts !== undefined && opts.silent === true;
        const full = !chartsOnly; // full=初始 load/用户显式刷新（可改 phase）；chartsOnly=换档/静默拍
        const seq = ++seqRef.current;
        if (!silent) {
          inflightRef.current += 1;
          if (inflightRef.current === 1) safeSet(() => setRefreshing(true));
        }
        if (initial) safeSet(() => setPhase("loading"));
        const wrote = {};  // key -> "ok"|"err"，只含本轮真正发起的路线
        const values = {};
        try {
          const jobs = [
            // 静默拍带 summary（按需刷热力图要用它判定）；换档拍不带（只需趋势/模型）
            full || silent ? ["summary", api.summary()] : null,
            full ? ["heatmap", api.heatmap()] : null,
            ["trend", api.trend(rangeArg)],
            rangeArg === 1 ? null : ["models", api.models(rangeArg)], // 今日档不请求 /models
          ].filter((job) => job !== null);
          const settled = await Promise.allSettled(jobs.map((job) => job[1]));
          jobs.forEach((job, i) => {
            const key = job[0];
            const res = settled[i];
            if (res.status !== "fulfilled") {
              wrote[key] = "err";
              console.warn(PREFIX + "读取 " + key + " 失败：" + describeError(res.reason));
              return;
            }
            if (!validOf(key, res.value)) {
              wrote[key] = "err";
              console.warn(PREFIX + key + " 响应形状不符SPEC §5，按失败降级。");
              return;
            }
            wrote[key] = "ok";
            values[key] = res.value;
          });
          // 静默拍按需补热力图（§6）：只在总量/「今天」变了才拉——空闲时零额外请求。
          // 基线推进规则：只在「本轮不需要拉」或「拉到了」时推进 lastSumRef；
          // 拉了但失败则保留旧基线，下一拍（60s）自然重试——否则判定信号被消费，热力图静默冻结。
          let nextSum = null;
          let heatmapNeeded = false;
          if (wrote.summary === "ok") {
            nextSum = { totalTokens: Number(values.summary.totalTokens) || 0, today: dateKey(new Date()) };
            heatmapNeeded = full || needHeatmapRefreshOf(lastSumRef.current, nextSum);
            if (silent && heatmapNeeded) {
              try {
                const hmValue = await api.heatmap();
                if (validOf("heatmap", hmValue)) {
                  wrote.heatmap = "ok";
                  values.heatmap = hmValue;
                } else {
                  wrote.heatmap = "err";
                  console.warn(PREFIX + "heatmap 响应形状不符SPEC §5，按失败降级。");
                }
              } catch (error) {
                wrote.heatmap = "err";
                console.warn(PREFIX + "读取 heatmap 失败：" + describeError(error));
              }
            }
          }
          const attempted = Object.keys(wrote);
          const allFailed = attempted.length > 0 && attempted.every((key) => wrote[key] === "err");
          let computed = null;
          if (full || silent) {
            const sumVal = wrote.summary === "ok" ? values.summary : null;
            const hmVal = wrote.heatmap === "ok" ? values.heatmap : null;
            const empty = !allFailed && sumVal !== null && Number(sumVal.totalTokens) === 0
              && (hmVal === null || !Array.isArray(hmVal.days) || hmVal.days.every((d) => !(Number(d !== null && typeof d === "object" ? d.tokens : 0) > 0)));
            computed = allFailed ? "error" : empty ? "empty" : "ready";
          }
          if (seq !== seqRef.current) {
            // 过期响应：数据与 phase 一律丢弃（刷新闩由 finally 复位）。唯一例外=初始拍至少要
            // 把面板从 loading 里放出来——静默拍的单调规则救不了它（loading→empty 是 no-op），
            // 否则首装回填期间连「正在回填历史会话…」都看不到。
            if (initial && computed !== null) {
              const escaped = computed;
              safeSet(() => setPhase((prev) => (prev === "loading" ? escaped : prev)));
            }
            return;
          }
          safeSet(() => {
            if (wrote.summary === "ok") setSummary(values.summary);
            if (wrote.heatmap === "ok") setHmDays(values.heatmap.days);
            if (wrote.trend === "ok") setTrend(values.trend);
            if (wrote.models === "ok") setModelsResp(values.models);
            setBlockErr((prev) => {
              const next = Object.assign({}, prev);
              for (const key of attempted) next[key] = wrote[key] === "err";
              return next;
            });
            // 「更新于 HH:MM」（§6）：本轮实际发起的每一路都成功才推进（部分降级时冻结
            // 并由「部分数据未更新」标注——光冻结时间戳太弱，用户看不出是没变还是没拉到）
            if (attempted.length > 0) {
              const allOk = attempted.every((key) => wrote[key] === "ok");
              if (allOk) {
                setUpdatedAt(new Date());
                setStaleTick(false);
              } else {
                setStaleTick(true); // 已有数据的面板保留旧值，但明确标注本轮没取全
              }
            }
          });
          if (nextSum !== null && (!heatmapNeeded || wrote.heatmap === "ok")) lastSumRef.current = nextSum;
          if (computed !== null) {
            // §6：静默拍单调（只允许升到 ready）；full 拍全权
            safeSet(() => setPhase((prev) => phaseAfterTick(prev, computed, silent)));
          }
        } finally {
          if (!silent) {
            if (inflightRef.current > 0) inflightRef.current -= 1;
            if (inflightRef.current === 0) safeSet(() => setRefreshing(false));
          }
        }
      }, [safeSet]);

      react.useEffect(() => {
        void runLoad(30, { initial: true });
      }, [runLoad]);

      // 60s 轻轮询（§6/2）：silent 档，不进 loading/刷新态；静默拍只允许把面板从空态升级到
      // 就绪（治「空态没有自愈出路」），绝不把有数据的面板打成空态/错误态。回前台立即补一拍；
      // 后台标签页（document.hidden）跳拍；range 走 ref，换档不重挂定时器。
      react.useEffect(() => {
        const tick = () => {
          if (typeof document !== "undefined" && document.hidden === true) return;
          void runLoad(rangeRef.current, { chartsOnly: true, silent: true });
        };
        const timer = setInterval(tick, 60000);
        const onVisibility = () => {
          if (typeof document !== "undefined" && document.hidden !== true) tick();
        };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
        return () => {
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [runLoad]);

      const handleRange = (r) => {
        rangeRef.current = r;
        setRange(r);
        void runLoad(r, { chartsOnly: true });
      };
      const handleRefresh = () => {
        void runLoad(rangeRef.current, {});
      };

      // 回填跟踪（§6）：单一 ticker——挂载发现「正在跑」与手动发起共用它，绝不起第二条链。
      // origin 决定连续失败 3 次后的文案；卸载后 await 返回不再重挂句柄。
      const backfillTick = react.useCallback(async () => {
        if (!mountedRef.current) return;
        let status = null;
        try {
          status = await api.backfillStatus();
          backfillFailRef.current = 0;
        } catch (error) {
          backfillFailRef.current += 1;
          console.warn(PREFIX + "回填进度查询失败：" + describeError(error));
        }
        if (!mountedRef.current) return; // 卸载发生在 await 里：不再重挂
        if (backfillFailRef.current >= 3) {
          stopBackfillTicker();
          safeSet(() => setBackfill({
            tracking: false, status: null,
            // 显式降级：冻结的假进度比报错更糟——退出跟踪态并把「刷新」按钮留给用户
            message: "回填进度暂不可查，可稍后点「刷新」。",
          }));
          return;
        }
        if (status !== null) {
          safeSet(() => setBackfill((prev) => ({ tracking: prev.tracking, status, message: prev.message })));
          if (status.running !== true) {
            // 失败信号判先于成功文案：后台崩溃若被报成「回填完成」，
            // 面板却因 daily 缺档显示暂无数据——自相矛盾的成功
            if (status.error !== undefined && status.error !== null && status.error !== "") {
              stopBackfillTicker();
              safeSet(() => setBackfill({ tracking: false, status, message: "回填失败：" + backfillErrorText({ message: status.error }) }));
              return;
            }
            const done = Math.max(0, Math.round(Number(status.backfilled) || 0));
            const records = Math.max(0, Math.round(Number(status.records) || 0));
            const observed = sawRunningRef.current;
            sawRunningRef.current = false;
            stopBackfillTicker();
            safeSet(() => setBackfill({ tracking: false, status, message: "回填完成：补了 " + done + " 个会话、" + records + " 条记录。" }));
            // 只在确实观察到过 running=true 时才全量刷新（首读即 false=本轮没跑过回填）
            if (observed) void runLoad(rangeRef.current, {});
            return;
          }
          sawRunningRef.current = true;
        }
        backfillTimerRef.current = setTimeout(() => { void backfillTick(); }, 800);
      }, [runLoad, safeSet]);

      // 单一入口（§6）：挂载发现「正在跑」从这里进入——唯一判据 backfillActiveRef
      // （不能用 state 的 tracking 当判据：它要等 React 提交，挂载竞态会放进第二条链）。
      const startBackfillTracking = (message, initialStatus) => {
        const msg = message === undefined ? null : message;
        if (backfillActiveRef.current) {
          // 已在跟：只更新文案，绝不另起链
          safeSet(() => setBackfill((prev) => ({ tracking: true, status: prev.status, message: msg === null ? prev.message : msg })));
          return;
        }
        backfillActiveRef.current = true;
        backfillFailRef.current = 0;
        safeSet(() => setBackfill({ tracking: true, status: initialStatus === undefined ? null : initialStatus, message: msg }));
        void backfillTick();
      };

      // 挂载即读一次状态（§6）：装载自动回填在跑时，面板立刻进入跟踪态——
      // 否则用户看到的是「暂无使用数据」，而真相是「正在回填」。
      react.useEffect(() => {
        let cancelled = false;
        void (async () => {
          let status = null;
          try {
            status = await api.backfillStatus();
          } catch (error) {
            console.warn(PREFIX + "装载时读取回填状态失败：" + describeError(error)); // 读不到不作为：主数据与手动路径照常
          }
          if (cancelled || !mountedRef.current) return;
          if (status !== null && status.running === true) startBackfillTracking(null, status);
        })();
        return () => { cancelled = true; };
      }, [backfillTick, safeSet]);

      const head = el("div", { key: "head", className: "dus-head" },
        el("div", { className: "dus-titleRow" },
          el("div", { className: "dus-title" }, "使用统计"),
          el("span", { className: "dus-badge" }, "应用用量"),
        ),
        el("div", { className: "dus-sub" }, "查看会话活跃度与模型用量的粗略统计。"),
      );
      const ui = backfillUiOf({
        tracking: backfill.tracking,
        scanned: backfill.status === null ? null : backfill.status.scanned,
        total: backfill.status === null ? 0 : backfill.status.total,
      });
      const footRow = el("div", { key: "foot", className: "dus-footRow" },
        // 「更新于 HH:MM」：页脚左端，本轮全部路线成功才推进；有路失败时显式标注，
        // 免得用户把「冻结的时间戳」读成「数据没变」
        updatedAt !== null ? el("span", {
          key: "upd", className: "dus-updatedAt",
          title: staleTick ? "最近一次刷新有部分数据没取到，显示的是上一次的值" : undefined,
        }, "更新于 " + fmtClock(updatedAt) + (staleTick ? "（部分数据未更新）" : "")) : null,
        el("button", {
          type: "button", className: "dus-btnOutline", disabled: refreshing, onClick: handleRefresh,
        }, REFRESH_ICON, refreshing ? "刷新中…" : "刷新"),
      );
      const footMsg = backfill.message === null ? null : el("div", { key: "footMsg", className: "dus-hintLine" }, backfill.message);

      if (phase === "loading") {
        // StateBox 只渲染 title/desc（不渲染 children）——旧写法把文案当 children 传进去，
        // 首屏实际是一个空白盒
        return el("div", { className: "dus-root" }, head, el(StateBox, { key: "state", desc: "加载中…" }), footRow, footMsg);
      }
      if (phase === "error") {
        return el("div", { className: "dus-root" }, head,
          el(StateBox, {
            key: "state", title: "加载失败",
            desc: "统计服务暂时不可用，请稍后重试。",
            onRetry: handleRefresh,
          }),
          footRow, footMsg);
      }
      if (phase === "empty") {
        // 跟踪态与空态是同一块位置的两个面貌（§6）：正在回填时说「正在回填历史会话…」，
        // 而不是把真相藏在一句「暂无使用数据」后面
        return el("div", { className: "dus-root" }, head,
          el(StateBox, { key: "state", title: ui.emptyTitle, desc: ui.emptyDesc }),
          footRow, footMsg);
      }

      // ready：六块 UI。单路失败不炸面板——对应块给显式降级行（可见降级）。
      const children = [head];
      children.push(summary === null
        ? el("div", { key: "strip", className: "dus-card" },
          blockErr.summary === true
            ? el(DegradeLine, { text: "摘要数据加载失败，请重试。", onRetry: handleRefresh })
            : el("div", { className: "dus-hintLine" }, "加载中…"))
        : el("div", { key: "strip", className: "dus-card" }, el(SummaryStrip, { summary })));
      if (hmDays === null) {
        children.push(el("div", { key: "hm", className: "dus-card dus-cardTight" },
          el("div", { className: "dus-secHead" }, el("div", { className: "dus-secTitle" }, "Token 活动")),
          // 「本轮拉失败」才叫降级；「还没到」只是加载中——两者不能混
          blockErr.heatmap === true
            ? el(DegradeLine, { text: "活动数据加载失败，请重试。", onRetry: handleRefresh })
            : el("div", { className: "dus-hintLine" }, "加载中…")));
      } else {
        children.push(el(HeatmapCard, { key: "hm", days: hmDays, mode: hmMode, onMode: setHmMode, stale: blockErr.heatmap === true }));
      }
      const rangeLabel = (RANGE_MODES.filter((o) => o.value === range)[0] || { label: "" }).label;
      children.push(el("div", { key: "range", className: "dus-secHead dus-rangeHead" },
        el("div", { className: "dus-secTitle" }, "时间范围"), // §6：这组只作用于折线 + 环形
        el(Pills, { options: RANGE_MODES, value: range, onChange: handleRange }),
      ));
      children.push(el(TrendCard, { key: "trend", trend, err: blockErr.trend === true, onRetry: handleRefresh, rangeLabel }));
      children.push(el(DonutCard, {
        key: "donut", trend, modelsResp, range, err: blockErr.models === true && range !== 1, onRetry: handleRefresh,
      }));
      children.push(footRow);
      if (footMsg !== null) children.push(footMsg);
      return el("div", { className: "dus-root" }, children);
    }

    //#endregion

    //#region 设置区错误边界（slot 组件崩溃=整页设置白屏）
    class SectionBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = () => { this.setState({ error: null }); };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        console.warn(PREFIX + "面板渲染异常，已降级为兜底横幅：" + describeError(error));
      }
      render() {
        if (this.state.error !== null) {
          return el("div", { className: "dus-root" },
            el("div", { className: "dus-head" },
              el("div", { className: "dus-titleRow" },
                el("div", { className: "dus-title" }, "使用统计"),
                el("span", { className: "dus-badge" }, "应用用量"),
              ),
              el("div", { className: "dus-sub" }, "查看会话活跃度与模型用量的粗略统计。"),
            ),
            el("div", { className: "dus-stateBox" },
              "统计面板渲染异常，数据采集不受影响。详情已打印到控制台（F12 查看）",
              el("div", { className: "dus-stateBtn" },
                el("button", { type: "button", className: "dus-btnOutline", onClick: this.retry }, "重试"),
              ),
            ),
          );
        }
        return this.props.children;
      }
    }
    function BoundedSection(props) {
      return el(SectionBoundary, null, el(UsageStatsSection, props));
    }
    //#endregion

    //#region apply（生命周期装配）
    function apply(ctx) {
      if (ctx === null || typeof ctx !== "object" || ctx.slots === null || ctx.slots === undefined) {
        // fail-visible：注册不了就明说，绝不静默装死。
        console.warn(PREFIX + "宿主未提供 slots，设置分区未注册。");
        return;
      }
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-usage-stats",
            order: 13,
            label: () => "使用统计",
          },
          BoundedSection,
        ),
      );
    }
    //#endregion

    const inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    // 测试直测面（纯函数集合；零 DOM 依赖，node:test 桩 require 物化后可直调）。
    exports.__pure = Object.freeze({
      fmtCompact,
      fmtFull,
      fmtDuration,
      fmtStreak,
      dateKey,
      parseDateKey,
      addDays,
      fmtDayCn,
      fmtFullDayCn,
      hmLevel,
      hmColumnsOf,
      hmMonthLabelsOf,
      hmRenderOf,
      monotonePath,
      paletteVar,
      modelValueOf,
      trendModelRowsOf,
      donutRowsOf,
      donutArcPath,
      validOf,
      // v0.2.0 增量（SPEC §6）
      phaseAfterTick,
      summaryCellsOf,
      tipPlacementOf,
      tipRowsOf,
      pctTextOf,
      donutTipTextOf,
      needHeatmapRefreshOf,
      cursorStepOf,
      backfillUiOf,
    });
    // 组件面（供行为级直测；宿主只读 apply/inject，多导出无副作用）
    exports.__ui = Object.freeze({
      UsageStatsSection,
      SummaryStrip,
      HeatmapCard,
      TrendCard,
      DonutCard,
      TipCard,
      DegradeLine,
      StateBox,
      Pills,
    });
    return module.exports;
  },
});
