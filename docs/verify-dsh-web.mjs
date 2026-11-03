#!/usr/bin/env node
// dsh web 真机验证：搭一个与 desktop 同插件组合的测试实例，并用 agent-browser 驱动它。
//
// 为什么是 dsh web：desktop 是 Electron 且没开调试端口，agent-browser 连不上；
// dsh web 与 desktop 加载同一套 Web UI、读同一份数据，验证结论一致。
//
// 怎么用（详见 AGENTS.md「真机验证」）：
//   node docs/verify-dsh-web.mjs boot                  # 起测试实例（约 10s）
//   node docs/verify-dsh-web.mjs open                  # agent-browser 打开实例
//   node docs/verify-dsh-web.mjs snapshot              # 无障碍树，拿 @ref
//   node docs/verify-dsh-web.mjs click @e12            # 点击（ref 见 snapshot）
//   node docs/verify-dsh-web.mjs find role button click --name 使用统计   # 语义定位，不依赖 ref
//   node docs/verify-dsh-web.mjs screenshot <绝对路径>  # 截图
//   node docs/verify-dsh-web.mjs stop                  # 停实例 + 清理临时 profile
//
// 环境变量：DSH_CLI（dsh.cmd 路径）、DSH_DESKTOP_PROFILE（源 profile）、
//          VERIFY_PORT（默认 44000）、AGENT_BROWSER_SESSION（默认 dsh-verify）。
//
// 安全：实例地址带 token，任何输出都只打印掩码形态；含 token 的日志只落 .tmp/。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, openSync, closeSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir, tmpdir, platform } from 'node:os'

const STATE = join('.tmp', 'dsh-web-verify.json')
const MASK = (url) => url.replace(/token=[^&]+/, 'token=<masked>')
const isWin = platform() === 'win32'

const dshCli = process.env.DSH_CLI
  ?? 'C:/Users/bluechonk/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const desktopProfile = process.env.DSH_DESKTOP_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const port = Number(process.env.VERIFY_PORT ?? 44000)
const profileName = 'dsh-web-verify'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)
const logPath = join('.tmp', 'dsh-web-verify.log')
const urlPath = join('.tmp', 'dsh-web-verify.url')
const session = process.env.AGENT_BROWSER_SESSION ?? 'dsh-verify'

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null)
const writeState = (state) => { mkdirSync('.tmp', { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)) }
const clearState = () => { rmSync(STATE, { force: true }); rmSync(urlPath, { force: true }) }

/** 跑一条 agent-browser 命令：CLI 执行完可能留守护进程占住管道，所以输出写文件 + 超时兜底。 */
function ab(args, { timeout = 90000 } = {}) {
  const outFile = join(tmpdir(), `ab-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const fd = openSync(outFile, 'w')
  const cli = isWin ? 'agent-browser.cmd' : 'agent-browser'
  // Windows 上 .cmd 必须走 shell；参数统一加引号，避免 URL 里的 ? = 被拆开
  const quoted = args.map((a) => (/[^\w\-./:=@]/.test(a) ? `"${a}"` : a))
  let result
  try {
    result = spawnSync(cli, quoted, {
      env: { ...process.env, AGENT_BROWSER_SESSION: session },
      stdio: ['ignore', fd, fd],
      shell: isWin,
      windowsHide: true,
      timeout,
    })
  } finally {
    closeSync(fd)
  }
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch { /* ignore */ }
  try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
  return { code: result.status ?? -1, out: text }
}

/** 等日志里出现带 token 的实例地址（dsh web 启动后打印）。 */
async function waitForUrl(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(logPath)) {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/?\?[^\s]*token=[^\s&]+)/.exec(readFileSync(logPath, 'utf8'))
      if (m !== null) return m[1]
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('实例地址没有在 ' + timeoutMs + 'ms 内出现：' + logPath)
}

/** 停掉测试实例：先按记录的 pid，再按监听端口兜底（dsh 会派生子进程）。 */
function killInstance(state) {
  if (state?.pid !== undefined) { try { process.kill(state.pid, 'SIGKILL') } catch { /* ignore */ } }
  const netstat = spawnSync('cmd', ['/c', 'netstat', '-ano'], { encoding: 'utf8' })
  for (const line of (netstat.stdout ?? '').split(/\r?\n/)) {
    const m = new RegExp(':' + (state?.port ?? port) + '\\s+\\S+\\s+LISTENING\\s+(\\d+)').exec(line)
    if (m !== null) { try { process.kill(Number(m[1]), 'SIGKILL') } catch { /* ignore */ } }
  }
}

const cmd = process.argv[2] ?? ''
const arg = process.argv[3] ?? ''

try {
  mkdirSync('.tmp', { recursive: true })

  if (cmd === 'boot') {
    if (!existsSync(dshCli)) throw new Error('找不到 dsh CLI：' + dshCli + '（用 DSH_CLI 指定）')
    if (!existsSync(desktopProfile)) throw new Error('找不到 desktop profile：' + desktopProfile)
    if (readState() !== null) throw new Error('已有实例在跑，先执行 stop')
    if (existsSync(profileDir)) {
      spawnSync('cmd', ['/c', 'rmdir', join(profileDir, 'node_modules')], { stdio: 'ignore' })
      rmSync(profileDir, { recursive: true, force: true })
    }
    mkdirSync(profileDir, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      const from = join(desktopProfile, file)
      if (existsSync(from)) spawnSync('cmd', ['/c', 'copy', '/Y', from, join(profileDir, file)], { stdio: 'ignore' })
    }
    // 目录联接：与 desktop 共用同一份 node_modules（插件组合一致，免重装）
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', join(profileDir, 'node_modules'), join(desktopProfile, 'node_modules')], { encoding: 'utf8' })
    if (link.status !== 0) throw new Error('node_modules 联接失败：' + (link.stdout ?? '') + (link.stderr ?? ''))

    const out = openSync(logPath, 'w')
    const child = spawn('cmd', ['/c', dshCli, '--profile', profileName, '--port', String(port), '--no-open'], {
      stdio: ['ignore', out, out], windowsHide: true,
    })
    closeSync(out)
    writeState({ port, profile: profileName, pid: child.pid, logPath, urlPath })
    const url = await waitForUrl()
    writeFileSync(urlPath, url)
    child.unref() // 脚本退出后实例继续跑，stop 时按 state.pid / 端口清理
    console.log('测试实例已就绪（token 隐去）：' + MASK(url))
    console.log('完整地址见 ' + urlPath + '（含 token，勿外泄）')
  } else if (cmd === 'stop') {
    const state = readState()
    if (state !== null) {
      killInstance(state)
      if (existsSync(join(profileDir, 'node_modules'))) {
        spawnSync('cmd', ['/c', 'rmdir', join(profileDir, 'node_modules')], { stdio: 'ignore' })
      }
      rmSync(profileDir, { recursive: true, force: true })
      rmSync(logPath, { force: true })
      clearState()
      console.log('测试实例已停止，临时 profile 已删除')
    } else {
      console.log('没有正在运行的测试实例')
      clearState()
    }
  } else if (cmd === 'url') {
    if (!existsSync(urlPath)) throw new Error('还没有地址，先 boot')
    const url = readFileSync(urlPath, 'utf8').trim()
    if (arg === '--raw') {
      console.error('警告：--raw 会打印 token，不要写进日志或仓库')
      console.log(url)
    } else {
      console.log(MASK(url))
    }
  } else if (['open', 'snapshot', 'click', 'screenshot', 'eval', 'find'].includes(cmd)) {
    if (!existsSync(urlPath)) throw new Error('还没有实例地址，先 boot')
    const args = cmd === 'open' ? ['open', readFileSync(urlPath, 'utf8').trim()]
      : cmd === 'snapshot' ? ['snapshot', '-i']
      : cmd === 'click' ? ['click', arg]
      : cmd === 'screenshot' ? ['screenshot', resolve(arg)]
      : cmd === 'eval' ? ['eval', arg]
      : ['find', ...process.argv.slice(3)]
    const r = ab(args)
    if (r.out !== '') console.log(r.out)
    if (r.code !== 0) { console.error('agent-browser ' + cmd + ' 失败（exit ' + r.code + '）'); process.exitCode = 1 }
  } else {
    console.error('用法：node docs/verify-dsh-web.mjs <boot|stop|url|open|snapshot|click|screenshot|eval> [参数]')
    process.exitCode = 2
  }
} catch (error) {
  console.error('失败：' + (error?.stack ?? error))
  process.exitCode = 1
}
