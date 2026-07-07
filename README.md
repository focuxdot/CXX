<div align="center">

<img src="web/icons/logo.svg" width="120" alt="C叉叉" />

# C叉叉

### C叉叉是一个给本机 Codex / Claude Code 加上微信远程接管能力的增强工具。

<p><strong>在微信或任意手机浏览器里查看会话、审批命令、发起新一轮，并随时接管 <img src="public/icons/codex.svg" width="18" height="18" align="absmiddle" alt="Codex" /> Codex 和 <img src="public/icons/claude.svg" width="18" height="18" align="absmiddle" alt="Claude Code" /> Claude Code。</strong></p>

<p>
  <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/Codex%20%2F%20Claude-远程接管-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex and Claude Code" />
  <img src="https://img.shields.io/badge/端到端加密-X25519%20·%20AES--256--GCM-16a34a?style=flat-square&logo=letsencrypt&logoColor=white" alt="E2E" />
  <img src="https://img.shields.io/badge/微信-浮窗%20·%20接管-07C160?style=flat-square&logo=wechat&logoColor=white" alt="WeChat" />
</p>

**简体中文**　·　[English](./README.en.md)　·　[端到端协议](./public/PROTOCOL.md)　·　[安全说明](./public/SECURITY.md)

<br />

<img src="public/media/wechat.png" width="820" alt="在微信里使用 C叉叉：会话列表 · 切换电脑 · 实时对话" />

<sub>微信扫码即用 · Codex / Claude Code 会话列表、查看会话、对话、新建 · 添加到浮窗后随时从聊天返回工作台</sub>

</div>

---

Codex 或 Claude Code 一跑就是十几分钟到几十分钟，你却被拴在电脑前。C叉叉 让你离开工位也能接着看任务进展、
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
| 🧠 **双 Agent 支持** | Codex 是默认后端；检测到 Claude Code CLI 时，手机端可在 Codex / Claude Code 间切换 |
| 🔔 **主动通知** | 任务完成或卡在审批时推到微信/手机；点通知深链直达对应会话 |
| 🔒 **端到端加密** | X25519 + HKDF-SHA256 + AES-256-GCM，中继零知识，看不到你的代码、命令、对话 |
| 👀 **只读围观分享** | 生成单会话只读链接，把 Agent 干活过程分享出去；观众能看能鼓掌，进不了你的上下文 |
| 🖥️ **多机管理** | 一个微信浮窗管多台电脑上的 Codex / Claude Code |
| 🧩 **零依赖 · 可自建** | daemon 零 npm 依赖；中继跑官方托管，也可一条命令自建 |

## 🏁 快速开始

### macOS 一条命令安装

```bash
curl -fsSL https://github.com/focuxdot/CXX/releases/latest/download/install.sh | bash
```

安装脚本会下载最新 GitHub Release 里的 macOS 安装包，校验 `checksums.txt` 后把 `CXX.app` 安装到 `/Applications` 并打开。也可以手动下载：

- [install.sh](https://github.com/focuxdot/CXX/releases/latest/download/install.sh)
- [CXX-macos.dmg](https://github.com/focuxdot/CXX/releases/latest/download/CXX-macos.dmg)

### Windows 一条命令安装（PowerShell）

```powershell
irm https://github.com/focuxdot/CXX/releases/latest/download/install.ps1 | iex
```

安装脚本会下载最新 GitHub Release 里的 Windows 安装包，校验 `checksums.txt` 后静默安装并打开配对窗口。也可以手动下载：

- [CXX-win-x64.exe](https://github.com/focuxdot/CXX/releases/latest/download/CXX-win-x64.exe)

安装完成后，从桌面或开始菜单打开 **CXX**，会直接弹出扫码配对窗口。后台程序在安装目录的 `resources` 里，用户入口就是 `CXX.exe`。

### 使用者：桌面 App

> [!NOTE]
> macOS / Windows 可用；Linux 架构已预留，随后跟进。手机端是网页，iOS / 安卓 / 微信内置浏览器均可用。

1. **启动菜单栏程序**。首次未开启远程，界面按系统语言显示中文或英文。
2. 点菜单栏图标 → **扫码配对手机…**：首次点击即隐式开启远程（装 LaunchAgent 常驻并拉起 daemon；Codex 默认启用，检测到 Claude Code 时自动加入可切换列表）→ **显示配对二维码**。
3. **手机扫码配对**（微信「扫一扫」或浏览器）——凭据加密存在手机本地，之后免扫码直接进。
4. **开始远程**：在手机上查看 / 接管电脑上的 Codex 或 Claude Code 会话。

> [!TIP]
> 在微信里点右上角 `···` → **添加到浮窗**，之后随时从任意聊天一键返回工作台，接着盯任务、审批、发指令。

### 通知渠道

任务完成或卡在审批时主动推到你手机。（国内参考Server 酱等渠道投递到微信公众号，秒收）：

```bash
node daemon/src/main.mjs notify --add serverchan --key <你的SendKey>   # Server 酱（微信），到 https://sct.ftqq.com/ 拿 SendKey
node daemon/src/main.mjs notify --add bark     --key <key>            # Bark（iOS，可 --server 自托管）
node daemon/src/main.mjs notify --add wecom    --url <url>            # 企业微信群机器人
node daemon/src/main.mjs notify --add dingtalk --url <url>            # 钉钉群机器人
node daemon/src/main.mjs notify --add custom   --url <url>            # 自定义 webhook
node daemon/src/main.mjs notify --test                               # 发测试通知
node daemon/src/main.mjs notify --list                               # 查看 / --remove <序号> 删除
```

> [!WARNING]
> 通知只发**摘要**（事件类型 + 会话名），绝不含命令原文、代码或文件路径——第三方推送渠道是明文的，这是刻意的安全约束。

### 开发者：从源码自建运行

需要 Node ≥ 22 与已安装的官方 `codex` **≥ 0.142**（用 `codex --version` 确认）。daemon 启动时会校验
codex 版本，低于下限直接拒绝启动——它依赖的实验性 `app-server` 协议自 0.142 起才验证通过。

Claude Code 是可选后端：本机能找到 `claude` 且版本 ≥ 2.0.0 时，daemon 会自动注册 Claude Code agent；没安装时手机端只显示 Codex。

```bash
# 1. 启动本地 relay
node relay/node/server.mjs --port 8787

# 2. 启动 daemon（首次运行在 ~/.cxx/remote/ 下生成密钥与 daemonId）
node daemon/src/main.mjs start --relay ws://127.0.0.1:8787

# 3. 生成配对链接（另开终端）
node daemon/src/main.mjs pair

# 4. 手机打开打印出来的链接
```

端到端冒烟测试（拉起 relay + daemon + 模拟客户端，用你真实的 `codex` 断言 Codex 全链路）：

```bash
npm run smoke
```

由于 `app-server` 上游仍是实验特性，C叉叉 内置协议漂移守护：`npm run check:schema` 导出官方 app-server
的 JSON Schema 并与已提交的指纹（`daemon/schema/manifest.json`）比对，一有变化即失败。确认是预期变更后，
用 `npm run check:schema:update` 刷新基线。CI 在每次 push 用钉定的最低 codex 版本跑 schema 校验与冒烟，
并每天用 `codex@latest` 跑一次，尽早发现破坏性发布。

## 🧭 工作原理

官方 Codex CLI 已经有 `app-server` 和 `remote-control` 子命令，但 app-server 只绑定 `localhost`
（官方路径是 SSH 端口转发），既没中继穿透，也没手机端。Claude Code 则没有等价的常驻 app-server。
**C叉叉 在同一套手机端里补齐了远程接管层：Codex 走 app-server，Claude Code 走本地会话 JSONL + headless CLI。**

```
你的电脑                                              手机 / 微信
┌────────────────────────────┐                       ┌──────────────┐
│ 菜单栏程序（macOS）          │                       │  网页客户端   │
│   ⇅ launchctl / 配置文件     │                       │(github.io/CXX)
│            ▼                │                       └──────┬───────┘
│  daemon（Node · launchd）    │                             │ wss
│   └─ 拉起 ─┐                │      ┌────────────────┐      │
│            ▼                │─wss─▶│ relay（零知识    │◀─────┘
│  Codex app-server           │ E2E │ 转发）           │
│  Claude Code CLI / JSONL    │     └────────────────┘
└────────────────────────────┘
                                     ┌────────────────┐
        任务完成 / 待审批  ──webhook──▶│ Server 酱 等     │──▶ 微信推送
                                     └────────────────┘
```

- **daemon**——拉起官方 `codex app-server --listen`，并在检测到 `claude` CLI 时注册 Claude Code 后端；
  出站连接 relay，处理配对、设备管理、端到端加密（X25519 + HKDF-SHA256 + AES-256-GCM）、会话实时推送、webhook 通知。零 npm 依赖。
- **relay**——零知识转发器（按 `daemonId` 撮合 daemon↔client，逐帧转发密文，不持有任何密钥）。可跑在
  Cloudflare Worker 或单个 Node 进程。
- **web**——手机端页面（原生 JS + WebCrypto，无构建步骤；微信内核缺 X25519 时自动降级到纯 JS 实现）。
- **shell**——极薄的原生菜单栏程序，纯视图：daemon 作为独立的 launchd LaunchAgent 常驻，壳每次操作
  （配对 / 设备 / 通知 / 启停）只 shell 出 `cxx-daemon <子命令>`，退出托盘后远程仍继续运行。界面按系统
  语言显示中文或英文。macOS 先发，Windows/Linux 跟进。

数据全程端到端加密：daemon 持长期密钥，公钥随配对码分发；手机每次连接生成临时密钥，会话密钥由双方各自派生，
中继只搬运看不懂的密文。完整协议见 [public/PROTOCOL.md](./public/PROTOCOL.md)。

## ❓ 常见问答

<details>
<summary><b>C叉叉 自己包含 Codex / Claude Code 吗？</b></summary>

不包含。C叉叉 是一个远程接管增强工具，依赖你电脑上已经安装并登录好的 `codex` 或 `claude` CLI。
Codex 是默认后端；如果本机检测到可用的 Claude Code，手机端会自动出现 Claude Code 切换项。

</details>

<details>
<summary><b>要改动或替换我的 Codex / Claude Code 吗？</b></summary>

不需要。Codex 侧对接官方、未打补丁的二进制，在独立端口跑自己的 `app-server` 实例，不与官方 `remote-control`
抢控制 socket。Claude Code 侧调用本机 `claude` CLI 并读取它自己的会话文件，不改 Claude Code 本体。

</details>

<details>
<summary><b>中继（relay）能看到我的代码、命令、对话吗？</b></summary>

不能。所有应用层内容在 daemon 与手机之间端到端加密，中继是零知识转发器，不持有任何密钥或令牌，只按
`daemonId` 撮合并逐帧搬运密文。详见 [public/SECURITY.md](./public/SECURITY.md)。

</details>

<details>
<summary><b>微信里怎么就能收到通知、还能打开界面？</b></summary>

通知走 Server 酱这类 webhook——它把消息投递到微信公众号，国内也能秒收；点开深链，用微信内置浏览器打开手机端
页面即可接管。通知只含摘要，不含敏感内容。

</details>

<details>
<summary><b>只支持 macOS 吗？iOS / 安卓能用吗？</b></summary>

手机端是网页，**任何手机浏览器（含微信内置浏览器）都能用**，iOS / 安卓皆可。目前需要一台 **macOS** 电脑来跑
菜单栏程序 + daemon；Windows / Linux 的壳在规划中，daemon 与协议本身跨平台。

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

### 🔨 构建 macOS App

```bash
npm run build:app                  # 组装 dist/CXX.app（daemon + 菜单栏壳，ad-hoc 签名）
node scripts/build-app.mjs --dmg   # 同时产出 DMG
```

首次构建会下载官方 Node 运行时（Homebrew 的 node 不含 SEA fuse）并缓存到 `dist/.node-cache`。开发运行方式与
壳↔daemon 的后端子命令契约见 [shell/macos/README.md](./shell/macos/README.md)。

### 🤝 与官方项目的关系

- C叉叉 是 Codex / Claude Code 的远程操作增强工具，跟 OpenAI 或 Anthropic 官方项目没有隶属关系。


### 📄 许可证

[MIT](./LICENSE)
