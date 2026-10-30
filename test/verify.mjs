/**
 * 本地验证脚本（开发用，不随包发布到运行时）。
 * 运行：node test/verify.mjs
 *
 * 覆盖三件事：
 *   1. 模块能零依赖导入，导出形状对（name / apply / __internal）
 *   2. URL 提取与过滤规则对（下载命令、后缀、内网排除）
 *   3. apply() 挂的 tools/pre-execute 处理器行为对（转发、去重、放行、blockOriginDownload 拦截）
 */

const mod = await import('../dist/index.js')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`  √ ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  × ${name}${extra === undefined ? '' : `  -> ${extra}`}`)
  }
}

console.log('\n=== 1. 模块形状 ===')
ok('导出 name', mod.name === 'dsh-xunlei-bridge', mod.name)
ok('导出 apply 是函数', typeof mod.apply === 'function')
ok('导出 __internal.extractUrls', typeof mod.__internal?.extractUrls === 'function')

const { extractUrls, commandLooksDownload } = mod.__internal
const dc = 'download-commands'

console.log('\n=== 2. URL 提取与过滤 ===')
{
  const exec = {
    name: 'pwsh',
    arguments: { command: 'curl -L -O https://example.com/a.zip' },
  }
  const got = extractUrls(exec, dc)
  ok('curl -O .zip 被抓到', got.length === 1 && got[0].startsWith('https://example.com/a.zip'), JSON.stringify(got))
}
{
  const exec = { name: 'pwsh', arguments: { command: 'curl -s https://api.example.com/health' } }
  const got = extractUrls(exec, dc)
  ok('无后缀的接口请求不抓', got.length === 0, JSON.stringify(got))
}
{
  const exec = { name: 'web_fetch', arguments: { url: 'https://example.com/setup.exe' } }
  const got = extractUrls(exec, dc)
  ok('下载后缀即使无 curl 也抓', got.some((u) => u.endsWith('setup.exe')), JSON.stringify(got))
}
{
  const exec = { name: 'pwsh', arguments: { command: 'curl -O http://192.168.154.1/file.zip' } }
  const got = extractUrls(exec, dc)
  ok('内网地址被排除', got.length === 0, JSON.stringify(got))
}
{
  const exec = { name: 'pwsh', arguments: { command: 'curl -O http://127.0.0.1:8000/a.iso' } }
  const got = extractUrls(exec, dc)
  ok('本机地址被排除', got.length === 0, JSON.stringify(got))
}
{
  const exec = { name: 'web_fetch', arguments: { url: 'https://example.com/page' } }
  const got = extractUrls(exec, 'all-urls')
  ok('all-urls 模式抓普通网页', got.length === 1, JSON.stringify(got))
}
{
  ok('commandLooksDownload 认 Invoke-WebRequest', commandLooksDownload('Invoke-WebRequest -Uri x -OutFile y'))
  ok('commandLooksDownload 不认 ls', commandLooksDownload('ls -la') === false)
}
{
  // 嵌套参数也要能挖到
  const exec = { name: 'run_code', arguments: { code: { inner: ['wget https://example.com/b.tgz'] } } }
  const got = extractUrls(exec, dc)
  ok('嵌套结构里的链接能挖到', got.length === 1, JSON.stringify(got))
}

console.log('\n=== 3. apply() 行为 ===')
function makeStubCtx() {
  const logs = []
  const handlers = new Map()
  return {
    logs,
    handlers,
    ctx: {
      logger: {
        info: (...a) => logs.push(['info', a.join(' ')]),
        warn: (...a) => logs.push(['warn', a.join(' ')]),
        error: (...a) => logs.push(['error', a.join(' ')]),
      },
      on: (event, listener) => {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(listener)
      },
    },
  }
}

{
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  ok('注册了 tools/pre-execute', stub.handlers.has('tools/pre-execute'))
  ok('加载日志里有已加载提示', stub.logs.some(([l, t]) => l === 'info' && t.includes('已加载')))
}

// 让 next() 记录被调用次数
function makeNext() {
  const state = { calls: 0 }
  const next = async () => {
    state.calls += 1
    return { kind: 'allow' }
  }
  return { state, next }
}

{
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler(
    { name: 'pwsh', arguments: { command: 'curl -L -O https://example.com/x.zip' } },
    next,
  )
  ok('下载链接会转发（dryRun 打日志）', stub.logs.some(([, t]) => t.includes('试运行，本应唤起迅雷')))
  ok('默认放行原调用', decision.kind === 'allow' && state.calls === 1, JSON.stringify(decision))
}
{
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  await handler({ name: 'pwsh', arguments: { command: 'curl -O https://example.com/y.zip' } }, next)
  await handler({ name: 'pwsh', arguments: { command: 'curl -O https://example.com/y.zip' } }, next)
  const fw = stub.logs.filter(([, t]) => t.includes('本应唤起迅雷'))
  ok('同一链接去重（只转发一次）', fw.length === 1, `实际 ${fw.length} 次`)
}
{
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true, blockOriginDownload: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler(
    { name: 'pwsh', arguments: { command: 'curl -O https://example.com/z.exe' } },
    next,
  )
  ok('blockOriginDownload=true 时返回 deny', decision.kind === 'deny', JSON.stringify(decision))
  ok('blockOriginDownload=true 时不再调用 next', state.calls === 0, `next 被调用 ${state.calls} 次`)
}
{
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler({ name: 'read', arguments: { path: 'a.txt' } }, next)
  ok('无关调用直接放行且不转发', decision.kind === 'allow' && state.calls === 1)
  ok('无关调用没有转发日志', !stub.logs.some(([, t]) => t.includes('本应唤起迅雷')))
}
{
  // 传入畸形参数不应抛异常
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { next } = makeNext()
  let threw = null
  try {
    await handler({ name: 'x', arguments: null }, next)
    await handler({}, next)
    const circular = {}
    circular.self = circular
    await handler({ name: 'x', arguments: circular }, next)
  } catch (err) {
    threw = err
  }
  ok('畸形参数不抛异常', threw === null, threw && threw.message)
}
{
  // 已装的 xunlei_download 工具自己有提交通道，本插件必须让路，否则会重复建任务
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler(
    { name: 'xunlei_download', arguments: { urls: ['https://example.com/a.zip'] } },
    next,
  )
  ok('xunlei_download 被跳过且放行', decision.kind === 'allow' && state.calls === 1)
  ok('xunlei_download 不产生转发', !stub.logs.some(([, t]) => t.includes('本应唤起迅雷')))
}
{
  // 名字里带迅雷字样的自定义工具同样跳过
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler(
    { name: 'my_xunlei_tool', arguments: { command: 'curl -O https://example.com/b.zip' } },
    next,
  )
  ok('名字含 xunlei 的工具被跳过', decision.kind === 'allow' && state.calls === 1)
}
{
  // ignoreTools 可自定义
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true, ignoreTools: ['custom_dl'] })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { state, next } = makeNext()
  const decision = await handler(
    { name: 'custom_dl', arguments: { command: 'curl -O https://example.com/c.zip' } },
    next,
  )
  ok('自定义 ignoreTools 生效', decision.kind === 'allow' && state.calls === 1)
}
{
  // logFile 审计：dryRun 下也应写一行
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = path.join(os.tmpdir(), `xunlei-bridge-test-${Date.now()}.log`)
  const stub = makeStubCtx()
  mod.apply(stub.ctx, { dryRun: true, logFile: tmp })
  const handler = stub.handlers.get('tools/pre-execute')[0]
  const { next } = makeNext()
  await handler({ name: 'pwsh', arguments: { command: 'curl -O https://example.com/d.zip' } }, next)
  const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : ''
  ok('logFile 写入审计行', text.includes('dry-run') && text.includes('d.zip'), JSON.stringify(text))
  fs.rmSync(tmp, { force: true })
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
