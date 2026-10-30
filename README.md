# dsh-xunlei-bridge

> DSH（DeepSeek Harness）插件：拦截工具调用里出现的**下载链接**，自动交给迅雷新建下载任务。
> ⚠️ **仅 Windows 可用**（迅雷只有 Windows 客户端）；麒麟 / macOS 上插件会打印警告后自行退出。

## 它到底挂在哪里（和原方案的区别）

| 项目 | 原方案 | 实际实现 | 原因 |
|---|---|---|---|
| 钩子事件 | `dsh/download:before` | **`tools/pre-execute`** | DSH 0.1.5-rc.1 **不存在** download 事件：全包扫描没有任何 download 相关 emit，`dsh-tools` 只发 `tools/change`，真正的门控钩子是 `tools/pre-execute` / `tools/post-execute` |
| 依赖 `cordis` | `^3.0.0` | **不依赖任何第三方包** | npm 上 `cordis` 最新是 `4.0.0-rc.12`，`^3.0.0` 装不上；DSH 内部用的是 `@deepseek-ai/cordis@4.0.5`。本机另外三个在跑的插件（`@local/dsh-ai-tools` 等）都遵循「零外部 import」，否则 link 安装时整个 profile 起不来 |
| 加载声明 | 无 | **`dsh.bundle.patch` + `cordis.patch.yml`** | 这是硬门槛：插件 CLI 只把声明了 `dsh.bundle.patch` 的包当插件层，否则只当普通依赖安装、永不加载 |
| 迅雷路径 | `C:\Program Files\Thunder\Program\ThunderStart.exe` | `D:\Program Files (x86)\Thunder Network\Thunder\program\Thunder.exe` | 本机实际安装位置在 D 盘；`Thunder.exe "<URL>"` 是已实测可用的提交方式 |

`tools/pre-execute` 的官方签名（取自 DSH 自带的工具文档）：

```ts
'tools/pre-execute'(
  exec: ToolExecution,                       // exec.name / exec.arguments / exec.agent / exec.callId
  next: () => Promise<PreToolDecision>
): Promise<PreToolDecision>                  // 返回 {kind:'deny',reason} 可拦下本次调用
```

## ✅ 前置条件

1. 已安装迅雷，并且**提前打开迅雷**（否则只会拉起进程，窗口不会自动填好任务）。
2. 确认 `Thunder.exe` 真实路径（默认已按本机写好，换机器要改 `cordis.patch.yml`）。

## 📦 安装

```bash
# 从 GitHub 装（换成你的用户名）
dsh plugin --profile web add github:你的用户名/dsh-xunlei-bridge

# 或本地目录装（开发调试）
dsh plugin --profile web add ./
```

装完**重启 dsh web**，宿主日志里应出现：

```
[dsh-xunlei-bridge] 已加载：mode=download-commands dryRun=false blockOriginDownload=false 迅雷=...
```

## ⚙️ 配置项（都在 `cordis.patch.yml` 的 `config:` 里）

| 键 | 默认值 | 说明 |
|---|---|---|
| `thunderPath` | 本机 D 盘路径 | `Thunder.exe` 完整路径 |
| `mode` | `download-commands` | `download-commands`=只抓下载类命令里的链接；`all-urls`=抓所有 http(s) 链接（会把搜索/接口请求也丢给迅雷，一般别开） |
| `blockOriginDownload` | `false` | `false`=DSH 照旧下载，同时给迅雷一份（双路兜底）；`true`=拦下 DSH 自己的下载，只走迅雷 |
| `dryRun` | `false` | `true`=只写日志不真唤起迅雷，排障用 |
| `dedupeSeconds` | `600` | 同一链接的去重窗口，避免重复提交 |

### 什么算「下载链接」

`mode=download-commands` 下满足任一条件才抓：

- 工具调用的命令里出现 `curl` / `wget` / `aria2c` / `Invoke-WebRequest` / `Invoke-RestMethod` / `Start-BitsTransfer` / `iwr`
- 链接本身以常见下载后缀结尾：`.zip .7z .rar .tar .gz .xz .exe .msi .msu .cab .iso .img .deb .rpm .apk .dmg .pkg .pdf .mp4 .mkv ...`

并且**跳过** `localhost` / `127.0.0.1` / 内网段（`10.` `192.168.` `172.16-31.`）的地址——那些通常是内部接口。

## ❗ 已知限制（如实写，不吹）

1. **只能在 Windows 上跑**。其它平台插件打印警告后直接返回，不注册任何钩子。
2. **提交任务 ≠ 下载完成**。迅雷会弹「新建任务」窗口，需要**手动点「立即下载」**；非会员账号还可能被置为「已暂停」，需要再点「开始」。这是迅雷自家策略，命令行绕不过（`ThunderCmd.exe`、`-Silent` 都已实测失效）。
3. **带鉴权/防盗链的链接**只能把 URL 原样给迅雷，插件**不会**替你带 `Authorization` / `Referer` / Cookie，这类资源迅雷可能 403。
4. **临时 Token 链接**很快过期，交过去要尽快开始下。
5. **`tools/pre-execute` 不是对外承诺的稳定 API**，DSH 升级后可能改签名；升级后请先看 `dsh-tool-cordis` 里的接口文档再验证一次。
6. 插件**不校验**链接是否真能下载；它只负责转发。

## 🧪 本地开发

```bash
npm install     # 装 typescript + @types/node
npm run build   # 编译 index.ts -> dist/index.js
```

`dist/` **必须提交进 Git**：pnpm 从 git 安装时会拦下 `prepare` 构建脚本，靠 `dist` 才能直接被加载。

## 📝 License

MIT
