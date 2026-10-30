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

三种方式，按你的网络情况选：

```bash
# ① 标准方式（需要能访问 github.com，且 PATH 上有 git）
dsh plugin --profile web add github:Lmhc-5257/dsh-xunlei-bridge

# ② github.com 被墙 / 只有 codeload 能通时用这个（本机实测可用）
dsh plugin --profile web add https://codeload.github.com/Lmhc-5257/dsh-xunlei-bridge/tar.gz/refs/heads/main

# ③ 本地目录装（开发调试）
dsh plugin --profile web add C:/Users/<你>/dsh-xunlei-bridge
```

> ⚠️ **路径不要带空格**：`dsh plugin` 转发 pnpm 时不做引号处理，路径里有空格会被截断
> （实测 `...\DeepSeek Harness-ai\...` 被截成 `...\DeepSeek`，报 `ERR_PNPM_NOT_PACKAGE_DIRECTORY`）。
>
> ⚠️ **方式①的两个前提**：`git` 必须在 PATH 上（pnpm 要用 `git ls-remote` 解析），
> 且 `github.com:443` 可达。本机实测 `github.com` 连接被拒、`codeload.github.com` 正常，
> 所以方式②才是本机可用的那条。

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
| `logFile` | 未设置 | 设置后每转发一个链接就往该文件追加一行审计记录（`forwarded` / `dry-run` / `spawn-error`），用于事后核对 |
| `ignoreTools` | `['xunlei_download']` | 不参与拦截的工具名。**与 `@local/dsh-xunlei-download` 共存时必须保留**：那个插件注册的 `xunlei_download` 工具自己会提交迅雷，再被本插件抓一遍会在迅雷里出现两个一样的任务 |
| `hideMainWindow` | `true` | 提交任务时把**迅雷主界面**藏起来，只留「新建任务」对话框。**只在主窗口本来没开时才藏**，用户正开着的窗口不会被抢走 |
| `silentSubmit` | `true` | **连「新建任务」对话框也不显示**：提交后把它设成几乎全透明并自动点「立即下载」，任务直接开始下载，屏幕上什么都看不到。设为 `false` 则保留对话框自己确认 |

### 「一点迅雷界面都不显示」是怎么做到的

`silentSubmit: true` 时走 `bin/submit-thunder-task.ps1`，步骤是：

1. 先隐藏迅雷主窗口；
2. 等到「新建任务」对话框出现；
3. 给对话框加 `WS_EX_LAYERED` 并把 **alpha 设为 1**（不是 0——alpha=0 的窗口会被系统当成可穿透，点击直接漏到下层；alpha=1 肉眼已经看不见，但仍能接收点击）；
4. **强制激活该对话框**（`SetForegroundWindow` + `BringWindowToTop` + `SetActiveWindow`）；
5. 用真实鼠标输入点「立即下载」（`PostMessage` 的假点击 CEF 不认），位置按对话框尺寸的**标定比例**算：`x = 宽×0.853`、`y = 高×0.874`；
6. 点完把光标还原到原处，确认对话框已关闭，再把主窗口藏一次。

> ⚠️ **第 4 步不能省**。这是踩了很久才定位到的：对话框是 CEF 窗口，**窗口没被激活时它会静默吞掉点击**——表现就是"对话框关了，但任务没建、文件没下"。早先几次成功只是因为刚弹出的对话框本来就有前台焦点。

实测（迅雷 25.1.13.1637 / 150% 缩放 / 对话框物理尺寸 1020×594，按钮区 x≈754–985、y≈483–555）：
`ZoomIt.zip`、`PSTools.zip`(5.1 MB)、`SDelete.zip` 均在**无任何可见窗口**的情况下下载完成。

### 「不弹主界面」用的另一套（`hideMainWindow`，`silentSubmit:false` 时才用）

两条腿一起走，缺一条都能被迅雷的版本差异打穿：

1. **官方开关（辅助）**：`<迅雷>\Profiles\config.json` 里
   `TaskDefaultSettings.NewTaskDlgWithoutMainWnd = true`。
   注意这是**机器级**设置，迅雷退出时可能把它写回 `false`，升级也可能改键名，所以只当辅助。
2. **窗口兜底（主保证）**：插件随包分发 `bin/hide-thunder-main.ps1`，提交任务后
   轮询并 `ShowWindow(SW_HIDE)` 掉迅雷主窗口（判定：类名 `Chrome_WidgetWin_0` 且标题为「迅雷」，
   或宽度 ≥ 900 的 CEF 大窗口），**不匹配** 680 宽的「新建任务」对话框。隐藏而非关闭，
   用户仍可从托盘还原。

提交前会先用 `-Query` 查一次主窗口是否已经可见：
**可见 → 不动它**（不抢用户正在用的窗口）；**不可见 → 藏起来**（防止迅雷把它带出来）。

> 实测（Windows 11 + 迅雷 25.1.13.1637）：主窗口 `1082x722`、标题恰好「迅雷」；
> 「新建任务」对话框 `680x396`（展开态 `680x683`）；另一个常驻的
> `suspension-renderer`（`810x694`）**不是**主窗口，不会被动。
>
> ⚠️ `hide-thunder-main.ps1` **故意写成纯 ASCII**：中文窗口名用码点（`U+8FC5 U+96F7`）拼，
> 注释用英文。因为 Windows PowerShell 5.1 会把 UTF-8 无 BOM 的文件按 ANSI 解码，
> 带中文的脚本会直接语法报错。

### 什么算「下载链接」

`mode=download-commands` 下满足任一条件才抓：

- 工具调用的命令里出现 `curl` / `wget` / `aria2c` / `Invoke-WebRequest` / `Invoke-RestMethod` / `Start-BitsTransfer` / `iwr`
- 链接本身以常见下载后缀结尾：`.zip .7z .rar .tar .gz .xz .exe .msi .msu .cab .iso .img .deb .rpm .apk .dmg .pkg .pdf .mp4 .mkv ...`

并且**跳过** `localhost` / `127.0.0.1` / 内网段（`10.` `192.168.` `172.16-31.`）的地址——那些通常是内部接口。

## ❗ 已知限制（如实写，不吹）

1. **只能在 Windows 上跑**。其它平台插件打印警告后直接返回，不注册任何钩子。
2. **`silentSubmit` 是界面自动化，不是接口**：它靠「截图外的窗口操作 + 真实鼠标点击」实现，
   过程中**你的鼠标会被短暂移动一下再还原**（约 0.5 秒）。全屏游戏、远程桌面、
   锁屏等场景下可能失效。
3. **同一个 URL 迅雷已有历史记录时可能不生效**：迅雷会走「任务已存在 / 文件已删除」分支，
   弹的是另一种对话框，按钮位置与文案都不同，脚本按标定位置点击可能落空。
   实测 `SDelete.zip`（已下过又删掉）复投时就没建任务，而全新 URL（`PSTools.zip`）一次成功。
4. **非会员账号可能被置为「已暂停」**，需要去迅雷里点「开始」——这是迅雷自家策略，
   命令行与界面自动化都绕不过（`ThunderCmd.exe`、`-Silent` 都已实测失效）。
5. **带鉴权/防盗链的链接**只能把 URL 原样给迅雷，插件**不会**替你带 `Authorization` / `Referer` / Cookie，这类资源迅雷可能 403。
6. **临时 Token 链接**很快过期，交过去要尽快开始下。
7. **`tools/pre-execute` 不是对外承诺的稳定 API**，DSH 升级后可能改签名；升级后请先看 `dsh-tool-cordis` 里的接口文档再验证一次。
8. 插件**不校验**链接是否真能下载；它只负责转发。

> 想要「稳」，把 `silentSubmit` 设成 `false`：只隐藏主界面，任务对话框留给你自己确认，
> 这样不会有任何落空风险。

## 🧪 本地开发

```bash
npm install     # 装 typescript + @types/node
npm run build   # 编译 index.ts -> dist/index.js
```

`dist/` **必须提交进 Git**：pnpm 从 git 安装时会拦下 `prepare` 构建脚本，靠 `dist` 才能直接被加载。

## 📝 License

MIT
