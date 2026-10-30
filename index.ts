/**
 * dsh-xunlei-bridge —— DSH 插件（宿主侧 / host 半）
 *
 * 作用：拦截 DSH 工具调用里出现的**下载链接**，自动交给迅雷新建下载任务。
 *
 * 为什么不用 `dsh/download:before`：
 *   DSH 0.1.5-rc.1 **没有**这个事件（全包扫描无 download 相关事件），
 *   真正可用的门控钩子是 `tools/pre-execute`（waterfall，签名见下）。
 *
 * 依赖说明：本文件**不 import 任何第三方包**（只用 node 内置）。
 *   插件以 link: / git: 方式装进 profile 时自身没有可解析的 node_modules，
 *   一旦 import 外部包，整个 profile 会启动失败（本机其它插件同样遵循此规则）。
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** 门控决策：与 DSH 的 PreToolDecision 形状一致。 */
interface PreToolDecision {
  kind: 'allow' | 'deny' | 'ask'
  reason?: string
}

/** tools/pre-execute 收到的执行对象（只声明本插件用到的字段）。 */
interface ToolExecutionLike {
  name?: string
  arguments?: unknown
}

/** cordis 上下文的最小形状，避免为了类型而引入外部依赖。 */
interface CtxLike {
  logger?: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  on(
    event: string,
    listener: (...args: any[]) => any,
    options?: { prepend?: boolean },
  ): unknown
}

/** cordis 插件名：DSH 加载插件时必须读到它。 */
export const name = 'dsh-xunlei-bridge'

/**
 * 本插件不依赖任何 cordis 服务，所以 inject 留空。
 * （本机其它插件写 inject: ['connection']，那是因为它们要用 connection 服务。）
 */
export const inject: string[] = []

/** 插件配置（在 profile 的 cordis.patch.yml 里以 config: 传入）。 */
export interface XunleiBridgeConfig {
  /** 迅雷可执行文件完整路径。 */
  thunderPath?: string
  /** 识别模式：只认下载类命令，或抓取所有链接。 */
  mode?: 'download-commands' | 'all-urls'
  /** 是否禁止 DSH 自己下载（true=只走迅雷；false=两路都下，迅雷作备份）。 */
  blockOriginDownload?: boolean
  /** 试运行：只写日志、不真的唤起迅雷。 */
  dryRun?: boolean
  /** 同一个链接的去重时间窗口（秒），防止重复提交。 */
  dedupeSeconds?: number
  /**
   * 审计日志文件路径。设置后每转发一个链接就往里追加一行，
   * 便于事后核对「到底交给迅雷了哪些链接」（也用于自动化验收断言）。
   */
  logFile?: string
  /**
   * 不参与拦截的工具名。默认排除 `xunlei_download`——本机已装了
   * `@local/dsh-xunlei-download`，它注册了同名工具自己会提交迅雷，
   * 如果再被本插件抓一遍，同一个链接会出现两个迅雷任务。
   */
  ignoreTools?: string[]
}

/** 名字里带这些词的工具有自己的下载通道，一律不拦。 */
const IGNORE_NAME_RE = /xunlei|迅雷/i

/** 本机实测的默认迅雷路径（用户机器为 D 盘，不是 C 盘）。 */
const DEFAULT_THUNDER =
  'D:\\Program Files (x86)\\Thunder Network\\Thunder\\program\\Thunder.exe'

/** 被视为「这是个下载任务」的文件后缀。 */
const DOWNLOAD_EXT =
  /\.(zip|7z|rar|tar|gz|xz|bz2|tgz|exe|msi|msu|cab|iso|img|deb|rpm|apk|dmg|pkg|pdf|mp4|mkv|avi|flac|whl)(\?|#|$)/i

/** 下载类命令行特征（PowerShell / cmd / unix 三套都覆盖）。 */
const DOWNLOAD_CMD =
  /(curl|wget|aria2c|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|iwr)\b/i

/** URL 里常见但不该抓的东西：本地地址、示例域名。 */
const URL_RE = /https?:\/\/[^\s"'`<>()\[\]{}|\\^]+/gi

/** 判断一个 URL 是否值得交给迅雷。 */
function looksDownloadable(url: string, mode: 'download-commands' | 'all-urls'): boolean {
  if (mode === 'all-urls') return true
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return false
    // 排除本机与局域网地址：那些多半是内部接口，不该丢给迅雷
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(parsed.hostname)) return false
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) return false
    return DOWNLOAD_EXT.test(parsed.pathname + parsed.search) || DOWNLOAD_EXT.test(url)
  } catch {
    return false
  }
}

/** 命令字符串看起来像是在下载吗。 */
function commandLooksDownload(command: string): boolean {
  return DOWNLOAD_CMD.test(command)
}

/** 深度遍历任意值，收集其中的字符串。 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out, depth + 1)
    }
  }
}

/** 从一次工具调用里抽出所有候选 URL。 */
function extractUrls(
  exec: ToolExecutionLike,
  mode: 'download-commands' | 'all-urls',
): string[] {
  const strings: string[] = []
  collectStrings(exec.arguments, strings)

  // 命令类工具：只有命令里出现下载动作时才抓，避免把搜索/接口请求丢给迅雷
  const commandish = strings.join('\n')
  const needsCommandCue = mode === 'download-commands' && commandLooksDownload(commandish)

  const found = new Set<string>()
  for (const text of strings) {
    if (mode === 'download-commands' && !needsCommandCue && !DOWNLOAD_EXT.test(text)) continue
    const matches = text.match(URL_RE)
    if (!matches) continue
    for (const raw of matches) {
      // 去掉尾部粘上的标点
      const url = raw.replace(/[.,;:!?]+$/, '')
      if (looksDownloadable(url, mode)) found.add(url)
    }
  }
  return [...found]
}

/** 插件主体。 */
export function apply(ctx: CtxLike, config: XunleiBridgeConfig = {}): void {
  const log = ctx.logger
  const say = (msg: string, ...rest: unknown[]) => log?.info?.(`[dsh-xunlei-bridge] ${msg}`, ...rest)

  if (process.platform !== 'win32') {
    log?.warn?.('[dsh-xunlei-bridge] 当前系统不是 Windows，插件不生效（迅雷只支持 Windows）')
    return
  }

  const thunderPath = config.thunderPath ?? DEFAULT_THUNDER
  const mode = config.mode ?? 'download-commands'
  const blockOriginDownload = config.blockOriginDownload ?? false
  const dryRun = config.dryRun ?? false
  const dedupeMs = (config.dedupeSeconds ?? 600) * 1000
  const logFile = config.logFile
  const ignoreTools = new Set(config.ignoreTools ?? ['xunlei_download'])

  /** 追加一行审计日志（失败不影响主流程）。 */
  function audit(line: string): void {
    if (logFile === undefined || logFile === '') return
    try {
      appendFileSync(logFile, `${new Date().toISOString()}\t${line}\n`, 'utf8')
    } catch (err) {
      log?.warn?.(
        `[dsh-xunlei-bridge] 审计日志写入失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** url -> 上次提交时间，用于去重。 */
  const recent = new Map<string, number>()

  /** 清理过期的去重记录，避免 Map 无限增长。 */
  function pruneRecent(now: number): void {
    for (const [url, at] of recent) {
      if (now - at > dedupeMs) recent.delete(url)
    }
  }

  /** 唤起迅雷新建任务。失败只记日志，绝不影响原工具调用。 */
  function forward(url: string): void {
    if (dryRun) {
      say(`试运行，本应唤起迅雷：${url}`)
      audit(`dry-run\t${url}`)
      return
    }
    try {
      const child = spawn(thunderPath, [url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.on('error', (err: Error) => {
        log?.error?.(`[dsh-xunlei-bridge] 唤起迅雷失败：${err.message}`)
        audit(`spawn-error\t${url}\t${err.message}`)
      })
      child.unref()
      say(`已提交迅雷：${url}`)
      audit(`forwarded\t${url}`)
    } catch (err) {
      log?.error?.(
        `[dsh-xunlei-bridge] 唤起迅雷异常：${err instanceof Error ? err.message : String(err)}`,
      )
      audit(`spawn-threw\t${url}\t${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 真正的挂载点：cordis waterfall，签名
  //   (exec, next) => Promise<PreToolDecision>
  // 返回 next() 表示放行；返回 {kind:'deny'} 表示拦下。
  ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => {
      let decision: PreToolDecision
      // 自己的逻辑无论如何不能弄崩别人的工具调用
      try {
        // 有自己下载通道的工具（如本机已装的 xunlei_download）不拦，避免重复提交
        const toolName = typeof exec.name === 'string' ? exec.name : ''
        if (toolName !== '' && (ignoreTools.has(toolName) || IGNORE_NAME_RE.test(toolName))) {
          return await next()
        }
        const urls = extractUrls(exec, mode)
        if (urls.length > 0) {
          const now = Date.now()
          pruneRecent(now)
          const fresh: string[] = []
          for (const url of urls) {
            const seen = recent.get(url)
            if (seen !== undefined && now - seen <= dedupeMs) continue
            recent.set(url, now)
            fresh.push(url)
          }
          for (const url of fresh) forward(url)

          if (blockOriginDownload && fresh.length > 0) {
            decision = {
              kind: 'deny',
              reason: `已转交迅雷下载：${fresh.join(' , ')}（blockOriginDownload=true，已阻止 DSH 直接下载）`,
            }
          } else {
            decision = await next()
          }
        } else {
          decision = await next()
        }
      } catch (err) {
        log?.error?.(
          `[dsh-xunlei-bridge] 前置处理异常，放行原调用：${err instanceof Error ? err.message : String(err)}`,
        )
        try {
          decision = await next()
        } catch {
          decision = { kind: 'allow' }
        }
      }
      return decision
    },
  )

  say(
    `已加载：mode=${mode} dryRun=${dryRun} blockOriginDownload=${blockOriginDownload} 迅雷=${thunderPath}`,
  )
}

/** 供宿主自检/单测使用的内部工具（不属于 cordis 接口）。 */
export const __internal = {
  extractUrls,
  looksDownloadable,
  commandLooksDownload,
}
