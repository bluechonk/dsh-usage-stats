// locale.test.mjs —— 客户端 i18n 字典契约测试（零 DOM、零依赖）。
//
// 字典内联在 lib/client.js（宿主 require 只认固定模块表，不支持相对路径 require，
// client 半必须单文件自包含），故此处从 client.js 的 __pure 直测面取字典。
//
// 守护三件事：
//   ① 中英两套字典的 key 集合完全一致（少一个 key = 那种语言下会漏显 key 本身）
//   ② 占位符集合一致（中英的 {name} 必须对齐，否则英文版会出现未替换的占位）
//   ③ 兜底翻译器行为与宿主一致（找不到 key 回退到 key 本身）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// —— 物化 client.js 的工厂（与 client.test.mjs 同款桩）——
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
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def.factory((id) => {
  if (id === "react") return reactStub;
  if (id === "react/jsx-runtime") return jsxStub;
  throw new Error("locale.test 桩未覆盖的 require：" + id);
}); } } };
await import("../lib/client.js");
delete globalThis.window;
assert.ok(captured !== null, "client.js 工厂未被物化");
const P = captured.__pure;

const ZH = P.localeDict.zh;
const EN = P.localeDict.en;

test("字典：中英 key 集合完全一致", { timeout: 5000 }, () => {
  const zhKeys = Object.keys(ZH).sort();
  const enKeys = Object.keys(EN).sort();
  const missingEn = zhKeys.filter((k) => !(k in EN));
  const missingZh = enKeys.filter((k) => !(k in ZH));
  assert.deepEqual(missingEn, [], "英文字典缺少 key：" + missingEn.join(", "));
  assert.deepEqual(missingZh, [], "中文字典缺少 key：" + missingZh.join(", "));
  assert.ok(zhKeys.length > 80, "字典条目过少，疑似没写完：" + zhKeys.length);
});

test("字典：中英占位符集合逐 key 一致", { timeout: 5000 }, () => {
  const placeholders = (s) => {
    const out = new Set();
    for (const m of String(s).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
    return [...out].sort();
  };
  for (const key of Object.keys(ZH)) {
    assert.deepEqual(
      placeholders(EN[key]),
      placeholders(ZH[key]),
      `key "${key}" 的中英占位符不一致（英文版会出现未替换的占位）`,
    );
  }
});

test("字典：值非空且无 undefined 残留", { timeout: 5000 }, () => {
  for (const [key, value] of Object.entries(ZH)) {
    assert.equal(typeof value, "string", `ZH["${key}"] 应为字符串`);
    assert.ok(value.length > 0, `ZH["${key}"] 为空`);
    assert.ok(!value.includes("undefined"), `ZH["${key}"] 含 undefined`);
  }
  for (const [key, value] of Object.entries(EN)) {
    assert.equal(typeof value, "string", `EN["${key}"] 应为字符串`);
    assert.ok(value.length > 0, `EN["${key}"] 为空`);
    assert.ok(!value.includes("undefined"), `EN["${key}"] 含 undefined`);
  }
});

test("字典：命名空间与宿主约定一致", { timeout: 5000 }, () => {
  assert.equal(P.localeNs, "dsh-usage-stats");
});

test("interpolate：填 {name}，未知占位保持原样（与宿主 translate 同规则）", { timeout: 5000 }, () => {
  assert.equal(P.interpolate("已扫 {scanned}/{total} 会话", { scanned: 3, total: 9 }), "已扫 3/9 会话");
  assert.equal(P.interpolate("值 {x}", { y: 1 }), "值 {x}", "未知占位应原样保留");
  assert.equal(P.interpolate("无占位", { x: 1 }), "无占位");
  assert.equal(P.interpolate("{a} {b}", { a: 1 }), "1 {b}");
});

test("fallbackT：命中 key 返回中文；未命中回退到 key 本身（与宿主行为一致）", { timeout: 5000 }, () => {
  const t = P.fallbackT();
  assert.equal(t("sectionLabel"), ZH.sectionLabel);
  assert.equal(t("notExistKey"), "notExistKey", "未命中的 key 必须回退到 key 本身");
  assert.equal(t("backfillDone", { sessions: 2, records: 5 }), "回填完成：补了 2 个会话、5 条记录。");
});

test("英文字典：关键界面文案确实是英文（防止误抄中文）", { timeout: 5000 }, () => {
  for (const key of ["sectionLabel", "sectionBadge", "summaryTotalTokens", "heatmapTitle", "trendTitle", "donutTitle", "stateEmpty"]) {
    assert.ok(!/[一-鿿]/.test(EN[key]), `EN["${key}"] 仍是中文：${EN[key]}`);
  }
  assert.equal(EN.sectionLabel, "Usage Stats");
});

test("诊断信息不进字典：日志与错误消息保持英文（SPEC §6.17）", { timeout: 5000 }, () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // console.warn 里的消息必须是英文
  for (const m of src.matchAll(/console\.warn\(PREFIX \+ "([^"]*)"/g)) {
    assert.ok(!/[一-鿿]/.test(m[1]), "console.warn 的消息应为英文（诊断信息不进界面字典）：" + m[1]);
  }
});

test("组件层的格式化调用都带上了 t（漏传会让英文版残留中文单位）", { timeout: 5000 }, () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 只查组件层（函数体内、非纯函数定义处）的调用：漏传 t 会渲染出中文「万/亿」
  const calls = [...src.matchAll(/fmtCompact\(([^()]*)\)/g)].map((m) => m[1]);
  const bare = calls.filter((args) => {
    const parts = args.split(",").map((x) => x.trim());
    if (parts.length === 1) return true;              // fmtCompact(v) —— 缺 t
    if (parts.length === 2) return !/props\.t|,\s*t\s*$/.test(parts[1]) && parts[1] !== "true";
    return !/props\.t|\bt\b/.test(parts[parts.length - 1]); // 第三参必须是 t
  });
  assert.deepEqual(bare, [], "这些 fmtCompact 调用漏传 t，英文版会残留中文单位：" + bare.join(" | "));
});

test("组件层不残留硬编码中文文案（除字典本身）", { timeout: 5000 }, () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 去掉字典块后再扫：剩下的中文只允许出现在注释里
  const dictStart = src.indexOf("const LOCALE_DICT = {");
  const dictEnd = src.indexOf("\n    };", dictStart);
  assert.ok(dictStart > 0 && dictEnd > dictStart, "未定位到字典块");
  const rest = src.slice(0, dictStart) + src.slice(dictEnd);
  // 去掉行注释与块注释
  const code = rest.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const hits = [...code.matchAll(/"([^"\\\r\n]*[一-鿿][^"\\\r\n]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hits, [], "代码里仍有硬编码中文文案（应走字典）：" + hits.join(" | "));
});
