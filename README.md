<div align="center">

<img src="web/icons/logo.svg" width="120" alt="C叉叉" />

##  C叉叉是一个给 ChatGPT / Claude Code 加上微信远程接管能力的增强工具

<p><strong>在微信或任意手机浏览器里查看会话、审批命令、发起新一轮，并随时接管 <img src="public/icons/codex.svg" width="18" height="18" align="absmiddle" alt="ChatGPT" /> ChatGPT 和 <img src="public/icons/claude.svg" width="18" height="18" align="absmiddle" alt="Claude Code" /> Claude Code。</strong></p>

<p>
  <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/ChatGPT%20%2F%20Claude-远程接管-412991?style=flat-square&logo=openai&logoColor=white" alt="ChatGPT and Claude Code" />
  <img src="https://img.shields.io/badge/端到端加密-X25519%20·%20AES--256--GCM-16a34a?style=flat-square&logo=letsencrypt&logoColor=white" alt="E2E" />
  <img src="https://img.shields.io/badge/微信-浮窗%20·%20接管-07C160?style=flat-square&logo=wechat&logoColor=white" alt="WeChat" />
</p>

**简体中文**　·　[English](./README.en.md)　·　[端到端协议](./public/PROTOCOL.md)　·　[安全说明](./public/SECURITY.md)

<br />

<img src="public/media/wechat.png" width="820" alt="在微信里使用 C叉叉：会话列表 · 切换电脑 · 实时对话" />

<sub>微信扫码即用 · ChatGPT / Claude Code 会话列表、查看会话、对话、新建 · 添加到浮窗后随时从聊天返回工作台</sub>

<br />

<img src="public/media/terminal.png" width="820" alt="终端模式：opencode · Claude Code · grok 三个终端在手机上远程运行" />

<sub>终端模式：在手机上远程跑起 opencode · Claude Code · grok 三个终端</sub>

</div>

---

ChatGPT 或 Claude Code 一跑就是十几分钟到几十分钟，你却被拴在电脑前。C叉叉 让你离开工位也能接着看任务进展、
审批命令、发新指令；任务完成或卡住时，通过微信 / Bark / Telegram / Slack 等渠道通知你。


> [!TIP]
> **不绑死微信**：任何手机浏览器都能用；通知也支持 Bark、企业微信、钉钉、自定义 webhook。微信只是国内最顺手的那条路。

## ✨ 为什么是「微信」

<table>
<tr>
<td width="33%" valign="top">

### 🔔 微信主动喊你
任务完成 / 需要审批时，通过配置多渠道推到微信公众号。

</td>
<td width="33%" valign="top">

### 📱 点开就接管
通知里的深链，用**微信内置浏览器**直接打开：看对话、审批命令、发新指令、切模型，全在微信里完成。不装 App、不用 SSH。

</td>
<td width="33%" valign="top">

### 🔒 加密照样成立
微信/安卓内核普遍缺 WebCrypto 的 X25519，C叉叉 自带**纯 JS 后备实现**，原生不可用时自动降级，端到端加密不打折。

</td>
</tr>
</table>

## 🚀 特性一览

| | |
| --- | --- |
| 📱 **手机远程接管** | 看对话、审批命令/改动、发起新一轮、切换模型与推理档位、中断当前轮 |
| 🧠 **双 Agent 支持** | ChatGPT 是默认后端；检测到 Claude Code CLI 时，手机端可在 ChatGPT / Claude Code 间切换 |
| ⌨️ **终端模式** | 在手机上开电脑的真终端窗口（xterm.js 全保真），Claude Code / OpenCode / Codex / Gemini CLI 或任意 Shell 都能远程跑；手机锁屏、daemon 更新重启都不丢会话 |
| 🔔 **主动通知** | 任务完成或卡在审批时推到微信/手机；点通知深链直达对应会话 |
| 📶 **同 WiFi 直连** | 手机和电脑在同一局域网时自动点对点直连，不经中继、毫秒级往返；离开局域网无缝回落 |
| 🔒 **端到端加密** | X25519 + HKDF-SHA256 + AES-256-GCM，中继零知识，看不到你的代码、命令、对话 |
| 👀 **只读围观分享** | 生成单会话只读链接，把 Agent 干活过程分享出去；观众能看能鼓掌，进不了你的上下文 |
| 🖥️ **多机管理** | 一个微信浮窗管多台电脑上的 ChatGPT / Claude Code |
| 🧩 **零依赖 · 可自建** | daemon 零 npm 依赖；中继跑官方托管，也可一条命令自建 |

## 🏁 快速开始

### 一条命令安装

**macOS / Linux**

```bash
curl -fsSL https://github.com/focuxdot/CXX/releases/latest/download/install.sh | bash
```

**Windows PowerShell**

```powershell
irm https://github.com/focuxdot/CXX/releases/latest/download/install.ps1 | iex
```

安装脚本会下载最新 GitHub Release 并校验 `checksums.txt`。

- **macOS**：装入 `/Applications`，打开菜单栏 App 扫码配对。
- **Linux**（CLI，无托盘）：装入 `~/.local/bin/cxx`，然后 `cxx enable` → `cxx pair`（把 JSON 里的 `url` 在手机打开）。SSH 要登出后仍常驻：`loginctl enable-linger $USER`。
- **Windows**：运行安装包后打开 **CXX** 托盘配对。

备用安装包： [CXX-macos.dmg](https://github.com/focuxdot/CXX/releases/latest/download/CXX-macos.dmg) · [CXX-win-x64.exe](https://github.com/focuxdot/CXX/releases/latest/download/CXX-win-x64.exe) · [cxx-linux-x64](https://github.com/focuxdot/CXX/releases/latest/download/cxx-linux-x64) · [cxx-linux-arm64](https://github.com/focuxdot/CXX/releases/latest/download/cxx-linux-arm64)

### 扫码 / 链接配对

> [!NOTE]
> **macOS / Windows** 提供菜单栏（托盘）壳；**Linux 为 CLI + systemd**（无托盘）。手机端是网页，iOS / 安卓 / 微信内置浏览器均可用。

**桌面（macOS / Windows）**

1. **启动菜单栏 / 托盘程序**。首次未开启远程，界面按系统语言显示中文或英文。
2. 点图标 → **扫码配对手机…**：首次点击即隐式开启远程（装 LaunchAgent / 计划任务并拉起 daemon）→ **显示配对二维码**。
3. **手机扫码配对**（微信「扫一扫」或浏览器）——凭据加密存在手机本地，之后免扫码直接进。
4. **开始远程**：在手机上查看 / 接管电脑上的 ChatGPT 或 Claude Code 会话。

**Linux（CLI）**

1. `cxx enable` — 写入 systemd user unit 并启动 daemon。  
2. `cxx pair` — 输出 JSON（含 `url`）；把链接发到手机浏览器打开完成永久绑定。临时场景用 `cxx pair-once`（5 分钟有效）。  
3. `cxx status` / `cxx devices` / `cxx notify …` 做运维与通知配置。

> [!TIP]
> 在微信里点右上角 `···` → **添加到浮窗**，之后随时从任意聊天一键返回工作台，接着盯任务、审批、发指令。

### 通知渠道

任务完成或卡在审批时主动推到你手机。（国内参考Server 酱等渠道投递到微信公众号，秒收）：

```bash
cxx notify --add serverchan --key <你的SendKey>   # Server 酱（微信），到 https://sct.ftqq.com/ 拿 SendKey
cxx notify --add bark     --key <key>            # Bark（iOS，可 --server 自托管）
cxx notify --add wecom    --url <url>            # 企业微信群机器人
cxx notify --add dingtalk --url <url>            # 钉钉群机器人
cxx notify --add custom   --url <url>            # 自定义 webhook
cxx notify --test                               # 发测试通知
cxx notify --list                               # 查看 / --remove <序号> 删除
```

> [!NOTE]
> `cxx` 是安装器（DMG / Windows 安装包）自动装到 PATH 上的全局命令，直接指向 App 内的同一个后台二进制——`cxx pair`、`cxx status`、`cxx devices` 等子命令同样可用。从源码运行则把 `cxx` 换成 `node daemon/src/main.mjs`。

> [!WARNING]
> 通知只发**摘要**（事件类型 + 会话名），绝不含命令原文、代码或文件路径——第三方推送渠道是明文的，这是刻意的安全约束。

### 终端模式（可选）

结构化会话之外，手机还能接管一个**真正的终端**：左上角 agent 选择器选「终端」→ **新建窗口**，
即在电脑上开一个终端窗口、从手机操作。启动方式可选 Claude Code、OpenCode、
Codex CLI、Gemini CLI，或普通 Shell；画面用 xterm.js 全保真渲染，ANSI / TUI / Vim 都能用，
并提供指令模式（适配手机输入）与键盘模式（原样击键）两套输入。

- **会话比连接活得久**：每个终端窗口由独立 `cxx-pty-host` 进程持有，手机锁屏断线、切后台、
  甚至 daemon 自动更新重启，里面跑的任务都不受影响；回来自动续上画面。
- **通知闭环**：终端响铃、进程退出、长时间静默会走上面的通知渠道推到手机，点深链直达该终端。
- **默认关闭，双重授权**：菜单栏 → **终端模式…** 打开全局开关并逐设备勾选授权
  （headless 用 `cxx terminal-enable 1` + `cxx terminal-access <deviceId> 1`）。
  只读围观链接永远无法使用终端；同一窗口同时只有一台设备可写，其余已授权设备只读、可显式接管。

### 命令行速查

日常用菜单栏图标即可；无图形界面的服务器 / headless Mac 上，安装器装到 PATH 的全局 `cxx` 命令就是完整入口（`cxx help` 看全部）：

```bash
# 远程服务
cxx enable | disable | status        # 开启自启并启动 / 停止并关自启 / 查看状态
# 配对与设备
cxx pair                             # 生成一次性配对二维码 / 链接
cxx devices                          # 列出已配对设备
cxx revoke <deviceId>                # 撤销某台设备
# 通知（见上一节）
cxx notify --list | --test | --add … # 管理通知渠道
# 终端模式
cxx terminal-status                  # 全局开关、各设备授权与运行中的窗口
cxx terminal-enable 1|0              # 打开 / 关闭终端模式
cxx terminal-access <deviceId> 1|0   # 授予 / 收回某台设备的终端权限
cxx terminal-close <terminalId>      # 结束一个终端窗口
# 其他
cxx check-update                     # 检查新版本
cxx version                          # 版本号
```

### 开发者：从源码自建运行

需要 Node ≥ 22 与已安装的官方 `codex` CLI **≥ 0.142**（用 `codex --version` 确认）。daemon 启动时会校验
`codex` 版本，低于下限直接拒绝启动——它依赖的实验性 `app-server` 协议自 0.142 起才验证通过。

Claude Code 是可选后端：本机能找到 `claude` 且版本 ≥ 2.0.0 时，daemon 会自动注册 Claude Code agent；没安装时手机端只显示 ChatGPT。

```bash
# 1. 启动本地 relay
node relay/node/server.mjs --port 8787

# 2. 启动 daemon（首次运行在 ~/.cxx/remote/ 下生成密钥与 daemonId）
node daemon/src/main.mjs start --relay ws://127.0.0.1:8787

# 3. 生成配对链接（另开终端）
node daemon/src/main.mjs pair

# 4. 手机打开打印出来的链接
```

端到端冒烟测试（拉起 relay + daemon + 模拟客户端，用你真实的 `codex` 断言 ChatGPT 全链路）：

```bash
npm run smoke
```

由于 `app-server` 上游仍是实验特性，C叉叉 内置协议漂移守护：`npm run check:schema` 导出官方 app-server
的 JSON Schema 并与已提交的指纹（`daemon/schema/manifest.json`）比对，一有变化即失败。确认是预期变更后，
用 `npm run check:schema:update` 刷新基线。CI 在每次 push 用钉定的最低 codex 版本跑 schema 校验与冒烟，
并每天用 `codex@latest` 跑一次，尽早发现破坏性发布。

## 🧭 工作原理

官方 ChatGPT 底层的 `codex` CLI 已经有 `app-server` 和 `remote-control` 子命令，但 app-server 只绑定 `localhost`
（官方路径是 SSH 端口转发），既没中继穿透，也没手机端。Claude Code 则没有等价的常驻 app-server。
**C叉叉 在同一套手机端里补齐了远程接管层：ChatGPT 走 `codex app-server`，Claude Code 走本地会话 JSONL + headless CLI，终端模式走独立的 `cxx-pty-host` PTY 宿主。**

```
你的电脑                                              手机 / 微信
┌────────────────────────────┐   同一 WiFi：WebRTC    ┌──────────────┐
│ 菜单栏程序（macOS）          │◀━ 点对点直连（E2E）━━▶│  网页客户端   │
│   ⇅ launchctl / 配置文件     │                       │(github.io/CXX)
│            ▼                │                       └──────┬───────┘
│  daemon（Node · launchd）    │                             │ wss
│   └─ 拉起 ─┐                │      ┌────────────────┐      │
│            ▼                │─wss─▶│ relay（零知识转发 │◀─────┘
│  ChatGPT app-server         │ E2E │ ·信令与备用通道） │
│  Claude Code CLI / JSONL    │     └────────────────┘
└────────────────────────────┘
                                     ┌────────────────┐
        任务完成 / 待审批  ──webhook──▶│ Server 酱 等     │──▶ 微信推送
                                     └────────────────┘
```

- **daemon**——拉起官方 `codex app-server --listen`，并在检测到 `claude` CLI 时注册 Claude Code 后端；
  出站连接 relay，处理配对、设备管理、端到端加密（X25519 + HKDF-SHA256 + AES-256-GCM）、会话实时推送、webhook 通知。零 npm 依赖。
- **relay**——零知识转发器（按 `daemonId` 撮合 daemon↔client，逐帧转发密文，不持有任何密钥），
  同时给局域网直连当信令通道。可跑在 Cloudflare Worker 或单个 Node 进程。
- **web**——手机端页面（原生 JS + WebCrypto，无构建步骤；微信内核缺 X25519 时自动降级到纯 JS 实现）。
- **shell**——极薄的原生菜单栏 / 托盘程序（macOS Swift、Windows 托盘），纯视图：daemon 由系统服务常驻
  （launchd / 计划任务），壳每次操作只 shell 出 `cxx-daemon <子命令>`，退出托盘后远程仍继续运行。
  **Linux 无壳**：同一套 `cxx` CLI + systemd `--user` 常驻。
- **pty-host**——终端模式的 PTY 宿主（Go 静态二进制）：每个终端窗口一个独立进程，持有
  unix PTY / Windows ConPTY 与 256KiB 回放缓冲；daemon 经本机 IPC 调用，更新重启后重新接管，
  终端里的任务不中断。

**同 WiFi 直连**：手机和电脑在同一个局域网时，网页端经由已认证的加密通道和 daemon 交换一次 WebRTC 信令，
直接建起点对点 DataChannel——数据不出局域网、不经任何服务器，往返毫秒级，家里断了外网也照常干活。
直连之上跑的仍是同一套端到端加密（X25519 + HKDF-SHA256 + AES-256-GCM）与设备鉴权，浏览器自带的 DTLS 只算外层运输；
不开监听端口、不用 STUN/TURN，不会把你的电脑暴露到公网。

不在同一网络或直连建不起来时，自动回落到中继：relay 按 `daemonId` 逐帧转发端到端密文、不持有任何密钥，切换无缝、不丢会话。
完整协议见 [public/PROTOCOL.md](./public/PROTOCOL.md)。

## ❓ 常见问答

<details>
<summary><b>C叉叉 自己包含 ChatGPT / Claude Code 吗？</b></summary>

不包含。C叉叉 是一个远程接管增强工具，依赖你电脑上已经安装并登录好的 `codex` 或 `claude` CLI。
ChatGPT 是默认后端；如果本机检测到可用的 Claude Code，手机端会自动出现 Claude Code 切换项。

</details>

<details>
<summary><b>要改动或替换我的 ChatGPT / Claude Code 吗？</b></summary>

不需要。ChatGPT 侧对接官方、未打补丁的 `codex` CLI，在独立端口跑自己的 `app-server` 实例，不与官方 `remote-control`
抢控制 socket。Claude Code 侧调用本机 `claude` CLI 并读取它自己的会话文件，不改 Claude Code 本体。

</details>

<details>
<summary><b>终端模式会接管我在 iTerm / Terminal 里已经开着的终端吗？</b></summary>

不会。终端模式只接管 C叉叉 自己创建的终端窗口，不附身你在其他终端 App 里的既有进程（技术上也不可行）。
它默认关闭，需要在电脑上打开全局开关并逐设备授权；手机发起的每个终端在电脑菜单栏都可见、可随时结束，
只读围观链接永远无法使用终端。

</details>

<details>
<summary><b>中继（relay）能看到我的代码、命令、对话吗？</b></summary>

不能。所有应用层内容在 daemon 与手机之间端到端加密，中继是零知识转发器，不持有任何密钥或令牌，只按
`daemonId` 撮合并逐帧搬运密文。详见 [public/SECURITY.md](./public/SECURITY.md)。

</details>

<details>
<summary><b>为什么 Mac 会询问“允许 cxx-daemon 查找本地网络中的设备”？绿点为什么会变成 WiFi 图标？</b></summary>

这是 C叉叉 在尝试把连接从中继升级为同一 WiFi 下的 WebRTC 点对点直连。绿点表示手机已经通过中继正常连接；
允许本地网络权限且直连成功后，图标会变成 WiFi，数据优先在局域网内直达电脑，中继仍保留作信令和备用通道。
拒绝权限不影响使用，只会继续走端到端加密的中继连接并显示绿点。C叉叉 不会扫描设备列表，此权限只用于连接已配对的手机。

</details>

<details>
<summary><b>微信里怎么就能收到通知、还能打开界面？</b></summary>

通知走 Server 酱这类 webhook——它把消息投递到微信公众号，国内也能秒收；点开深链，用微信内置浏览器打开手机端
页面即可接管。通知只含摘要，不含敏感内容。

</details>

<details>
<summary><b>支持哪些电脑系统？iOS / 安卓能用吗？</b></summary>

手机端是网页，**任何手机浏览器（含微信内置浏览器）都能用**，iOS / 安卓皆可。电脑侧：
**macOS / Windows** 有菜单栏（托盘）壳 + daemon；**Linux 为 CLI + systemd user 服务**（无托盘 / GUI），
适合服务器与多 Agent 主机。daemon 与协议本身跨平台。

</details>

<details>
<summary><b>Linux 上 SSH 断开后 daemon 会停吗？</b></summary>

默认 systemd **user** 服务随用户会话结束可能被停。若需要登出后仍常驻，执行
`loginctl enable-linger $USER`（一次即可）。日志在 `~/.cxx/remote/daemon.log`。

</details>

<details>
<summary><b>微信内置浏览器不支持某些加密，会不会连不上？</b></summary>

不会。国内微信 / 安卓内核普遍不支持 WebCrypto 的 X25519，C叉叉 自带经交叉验证的纯 JS 后备实现，原生不可用时
自动降级，端到端加密照常成立。

</details>

<details>
<summary><b>要花钱吗？</b></summary>

项目 MIT 开源。中继可用官方托管的公共 relay，也可一条命令自建（Cloudflare Worker 或 Node 单进程）。

</details>

<details>
<summary><b>手机丢了 / 想撤销某台设备怎么办？</b></summary>

每台设备（按浏览器 + 站点隔离，微信 / Chrome / Firefox 各算一台）持独立令牌，可单独撤销；撤销即时生效，
daemon 主动踢断在线连接，不等下次鉴权。

</details>

## 📦 更多

### 🔨 构建

```bash
npm run build:app                  # macOS：组装 dist/CXX.app（daemon + 菜单栏壳，ad-hoc 签名）
node scripts/build-app.mjs --dmg   # macOS：同时产出 DMG
npm run build:sea                  # 当前平台 SEA 单文件 → dist/sea/cxx-daemon（Linux/macOS 产物名）
npm run build:linux                # 同 build:sea（在 Linux 上构建发布用二进制）
```

首次构建会下载官方 Node 运行时（Homebrew 的 node 不含 SEA fuse）并缓存到 `dist/.node-cache`。开发运行方式与
壳↔daemon 的后端子命令契约见 [shell/macos/README.md](./shell/macos/README.md)。

### 🤝 与官方项目的关系

- C叉叉 是 ChatGPT / Claude Code 的远程操作增强工具，跟 OpenAI 或 Anthropic 官方项目没有隶属关系。


### 📄 许可证

[MIT](./LICENSE)
