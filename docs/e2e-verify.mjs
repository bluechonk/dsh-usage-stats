// 端到端验证脚本：用真实会话日志跑一遍回填，校验 Host 半四条 API 的响应形状。
// 只读本机会话日志，统计落盘到临时目录（不进 ~/.dsh/usage-stats），跑完自动清理。
//
// 用法：
//   node docs/e2e-verify.mjs [仓库根目录] [会话目录]
//   仓库根目录默认取本文件的上级目录；会话目录默认取 $DSH_HOME/sessions。
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const repo = process.argv[2] ?? dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const require = createRequire(join(repo, 'package.json'))
const mod = require(join(repo, 'lib', 'index.js'))

const storageRoot = mkdtempSync(join(tmpdir(), 'dus-e2e-'))
const sessionsRoot = process.argv[3] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
console.log('repo:', repo)
console.log('sessionsRoot:', sessionsRoot, existsSync(sessionsRoot) ? '存在' : '缺失')

// 构造最小 Cordis ctx：捕获注册的路由与事件监听
const routes = []
const listeners = {}
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  webServer: {
    register: (route) => { routes.push(route); return () => {} },
  },
  on: (evt, fn) => { (listeners[evt] ??= []).push(fn) },
  effect: (fn) => { const d = fn(); return d },
  inject: (deps, fn) => { fn(ctx) },
  timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
}

const cfg = mod.resolveConfig({ storageRoot, sessionsRoot })
console.log('config:', JSON.stringify(cfg))

await mod.apply(ctx, cfg)
console.log('registered routes:', routes.map((r) => r.path).join(', '))

// 触发回填：直接调 POST 路由 handler
const fakeReq = (method, url) => ({ method, url,
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:39180' } })
const fakeRes = () => ({ statusCode: 200, headers: {}, body: null,
  writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h); return this },
  setHeader(k, v) { this.headers[k] = v },
  end(b) { this.body = b } })
const post = routes.find((r) => r.path.endsWith('/backfill'))
const fakeResObj = fakeRes()
await post.handler(fakeReq('POST', '/api/dsh-usage-stats/backfill'), fakeResObj)
console.log('POST /backfill ->', fakeResObj.statusCode, fakeResObj.body)

// 轮询回填进度直到结束
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const status = routes.find((r) => r.path.endsWith('/backfill/status'))
  const res = fakeRes()
  status.handler(fakeReq('GET', '/api/dsh-usage-stats/backfill/status'), res)
  const s = JSON.parse(res.body)
  if (s.running === false) { console.log('backfill done:', JSON.stringify(s)); break }
  if (i % 10 === 0) console.log('  scanning...', JSON.stringify(s))
}

// 拉四条只读 API
for (const p of ['/summary', '/heatmap?days=30', '/trend?days=30', '/models?days=30']) {
  const route = routes.find((r) => r.path.endsWith(p.split('?')[0]))
  const res = fakeRes()
  route.handler(fakeReq('GET', '/api/dsh-usage-stats/' + p), res)
  const body = JSON.parse(res.body)
  console.log('\n=== GET', p, '->', res.statusCode)
  if (p.startsWith('/summary')) console.log(JSON.stringify(body, null, 2))
  else if (p.startsWith('/heatmap')) {
    const days = body.days ?? []
    console.log('days:', days.length, '有量天数:', days.filter((d) => d.tokens > 0).length)
    console.log('样本:', JSON.stringify(days.filter((d) => d.tokens > 0).slice(0, 3), null, 2))
  } else if (p.startsWith('/trend')) {
    console.log('granularity:', body.granularity, 'points:', body.points?.length)
    const last = body.points?.[body.points.length - 1]
    console.log('末点:', JSON.stringify(last, null, 2)?.slice(0, 900))
  } else console.log(JSON.stringify(body, null, 2)?.slice(0, 1200))
}

rmSync(storageRoot, { recursive: true, force: true })
console.log('\ncleaned store:', storageRoot)
