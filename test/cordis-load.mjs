/**
 * 真实 cordis 加载测试：证明插件能被 cordis 作为插件加载，且钩子在 waterfall 里真的被调用。
 *
 * 判定手法：传 blockOriginDownload=true，如果 waterfall 返回 {kind:'deny'}，
 * 说明我方的 tools/pre-execute 处理器确实被执行了（否则默认返回 allow）。
 *
 * 运行：node test/cordis-load.mjs
 */

import { pathToFileURL } from 'node:url'

const CORDIS = pathToFileURL(
  'C:\\Users\\梦尘\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
).href

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`  √ ${name}`)
  } else {
    fail += 1
    console.log(`  × ${name}${extra === undefined ? '' : `  -> ${extra}`}`)
  }
}

const { Context } = await import(CORDIS)
ok('cordis 的 Context 可用', typeof Context === 'function')

const mod = await import('../dist/index.js')

const app = new Context()

// 用 dryRun 保证不会真的拉起迅雷；blockOriginDownload 用来观测钩子是否执行
app.plugin(mod, { dryRun: true, blockOriginDownload: true })

// 等 cordis 的 fiber 把插件跑起来
await new Promise((resolve) => setTimeout(resolve, 300))

ok('cordis 接受该插件（未抛异常）', true)
ok('Context.waterfall 可用', typeof app.waterfall === 'function')

// 命中下载规则 → 期望 deny（证明处理函数被调用）
const hit = await app.waterfall(
  app,
  'tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'curl -L -O https://example.com/pkg.zip' } },
  () => Promise.resolve({ kind: 'allow' }),
)
ok('cordis 内命中下载链接 → deny', hit && hit.kind === 'deny', JSON.stringify(hit))

// 不命中 → 期望 allow
const miss = await app.waterfall(
  app,
  'tools/pre-execute',
  { name: 'read', arguments: { path: 'README.md' } },
  () => Promise.resolve({ kind: 'allow' }),
)
ok('cordis 内不命中 → allow', miss && miss.kind === 'allow', JSON.stringify(miss))

console.log(`\n===== cordis 加载测试：通过 ${pass}，失败 ${fail} =====`)
await app.stop?.()
if (fail > 0) process.exit(1)
