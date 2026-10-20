// 真机 UI 冒烟：驱动一个真实 DSH 实例，打开设置页「使用统计」，
// 断言面板完整渲染（摘要条/热力图/趋势图/环图/图例色/按钮），并抓控制台错误。
//
// 为什么需要它：单元测试用 React 桩，覆盖不到组件体内的深层分支
// （曾出现「删掉一个别名却漏改 3 处引用」，单元测试全绿、真机整页降级为兜底横幅）。
// 本脚本用 CDP 驱动真实浏览器，是唯一能覆盖真实渲染路径的验证手段。
//
// 用法：
//   node docs/smoke-ui.mjs <DSH实例URL（含token）> [Chrome路径] [输出目录]
//   Chrome 路径默认取 agent-browser 自带的 Chromium；输出目录默认 .tmp/
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.argv[2]
if (!url) {
  console.error('用法：node docs/smoke-ui.mjs <DSH实例URL> [Chrome路径] [输出目录]')
  process.exit(2)
}
const chrome = process.argv[3] ?? 'C:/Users/bluechonk/.agent-browser/browsers/chrome-155.0.8059.84/chrome.exe'
const outDir = process.argv[4] ?? '.tmp'
const port = 9350

if (!existsSync(chrome)) {
  console.error('找不到 Chrome：' + chrome + '（可用第 3 参数指定路径）')
  process.exit(2)
}

const chromeProc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--window-size=1400,1700',
  '--user-data-dir=' + join(outDir, 'chrome-profile-smoke'),
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null
let msgId = 0
const pending = new Map()
const consoleErrors = []
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

try {
  await sleep(5000)
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到浏览器页面目标')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('[EXC] ' + (msg.params.exceptionDetails.exception?.description ?? ''))
    }
  }
  await new Promise((r) => { ws.onopen = r })
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(7000)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }

  // 打开设置 → 使用统计
  const opened = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const acc = [...document.querySelectorAll('button,[role=button]')].find((c) => /账号菜单|Account/i.test(c.getAttribute('aria-label') || ''));
    if (acc) { acc.click(); await sleep(2000); }
    const cands = [...document.querySelectorAll('button,[role=menuitem],[role=button],a,li,div,span')];
    const hit = cands.find((c) => (c.textContent || '').trim() === '设置' && c.querySelectorAll('*').length < 4);
    if (hit) { hit.click(); await sleep(2500); }
    const sec = [...document.querySelectorAll('button,[role=button],a')].filter((n) => (n.textContent || '').trim() === '使用统计');
    if (sec.length) { sec[0].click(); await sleep(4500); }
    return { panel: !!document.querySelector('.dus-root') };
  })()`)
  if (opened?.panel !== true) {
    console.error('未打开「使用统计」面板')
    process.exitCode = 1
  }
  await sleep(2500)

  const info = await evalJs(`(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    return {
      title: q('.dus-title').map((t) => t.textContent),
      badge: q('.dus-badge').map((t) => t.textContent),
      strip: q('.dus-cell').map((c) => (c.querySelector('.dus-cellV')?.textContent) + ' / ' + (c.querySelector('.dus-cellK')?.textContent)),
      hmCells: q('.dus-hmCell').length,
      trendPaths: q('.dus-chartWrap path').length,
      legendColors: q('.dus-legendItem').map((i) => getComputedStyle(i.querySelector('.dus-legendSw')).backgroundColor),
      legendIsButton: q('.dus-legendItem').filter((i) => i.tagName === 'BUTTON').length,
      donutCenter: q('.dus-donutT').map((t) => t.textContent),
      secTitles: q('.dus-secTitle').map((t) => t.textContent),
      pills: q('.dus-pill').map((p) => p.textContent),
      footBtns: q('.dus-footRow button').map((b) => b.textContent),
    };
  })()`)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (shot?.data) {
    mkdirSync(outDir, { recursive: true })
    const f = join(outDir, 'ui-smoke.png')
    writeFileSync(f, Buffer.from(shot.data, 'base64'))
    console.log('截图：' + f)
  }

  console.log(JSON.stringify(info, null, 1))
  if (consoleErrors.length > 0) {
    console.log('=== 控制台错误 ===')
    console.log(consoleErrors.join('\n'))
  }

  // 断言
  const fail = []
  if (info.title[0] !== '使用统计') fail.push('标题缺失')
  if (info.badge[0] !== '应用用量') fail.push('「应用用量」徽章缺失')
  if (info.strip.length !== 6) fail.push('摘要条不是 6 格（实际 ' + info.strip.length + '）')
  if (info.hmCells < 300) fail.push('热力图格子数异常（' + info.hmCells + '）')
  if (info.trendPaths < 1) fail.push('趋势图没有曲线')
  if (info.legendColors.length < 1) fail.push('图例为空')
  if (new Set(info.legendColors).size < 2 && info.legendColors.length > 1) fail.push('图例颜色未区分（全部同色）')
  if (info.legendIsButton > 0) fail.push('图例仍可点击（应为纯展示）')
  if (info.donutCenter.length !== 1) fail.push('环图中心缺失')
  if (info.secTitles.length < 4) fail.push('区块数量不足：' + info.secTitles.join('/'))
  if (info.pills.length < 4) fail.push('胶囊数量不足：' + info.pills.join('/'))
  if (info.footBtns.join(',') !== '刷新') fail.push('页脚按钮应只有「刷新」，实际：' + info.footBtns.join(','))
  if (consoleErrors.length > 0) fail.push('控制台有错误（' + consoleErrors.length + ' 条）')

  if (fail.length > 0) {
    console.error('\nUI 冒烟失败：\n  - ' + fail.join('\n  - '))
    process.exitCode = 1
  } else {
    console.log('\nUI 冒烟通过：面板完整渲染，无控制台错误')
  }
} catch (error) {
  console.error('UI 冒烟异常：' + (error?.stack ?? error))
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  chromeProc.kill()
}
