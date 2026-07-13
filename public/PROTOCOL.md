# ChatGPT-叉叉 Remote 协议 v1

三个角色：**daemon**（用户电脑上的守护进程）、**client**（手机/浏览器）、**relay**（中继，Cloudflare Worker 或自托管 Node 变体）。

设计原则：relay 是零知识转发器——只做按 `daemonId` 撮合与逐帧转发，所有应用层内容在 daemon 与 client 之间端到端加密，relay 不持有任何密钥或令牌。

## 1. Relay 连接与转发帧

WebSocket 端点：

- `wss://<relay>/v1/daemon/<daemonId>?ver=<version>&inst=<bootId>` — daemon 出站注册。
  `inst` 是每次 daemon 进程启动生成的随机实例 id：同实例重连可替换自己的旧 socket；不同实例
  只有在旧 socket 最近 60s 无心跳时才能接管，旧/新进程不再无条件互踢。旧 daemon 不带参数时
  relay 以最近自动心跳时间和连接建立时间兼容判断。
- `wss://<relay>/v1/client/<daemonId>` — client 连接。relay 为每条 client 连接分配连接内唯一的 `cid`。

`daemonId`：16 字节随机数的 base64url（daemon 首次运行生成，持久化）。

转发帧为 JSON 文本帧，单帧上限 256 KiB，超限即断开：

| 方向 | 帧 | 说明 |
| --- | --- | --- |
| relay → client | `{"t":"status","online":bool,"lastSeen":ms\|null,"epoch":n?}` | 连接建立时告知 daemon 是否在线；daemon 上下线时推送。`lastSeen` 为 daemon 最近一次离线时刻（毫秒时间戳），在线或未知时为 null/缺省（旧 relay 不发此字段）。`epoch` 为 daemon 连接纪元（每次 daemon 接入 relay 递增，仅 online 时带）：顶替路径 relay 不广播 offline，client 靠 epoch 变化得知 daemon 侧连接态已重置、须重握手重鉴权 |
| relay → daemon | `{"t":"open","cid":"..."}` | 有 client 接入；daemon（重）上线时对每个已在线 client 补发一次 |
| client → relay | `{"t":"msg","data":{...}}` | data 为 E2E 信封（见 §2） |
| relay → daemon | `{"t":"msg","cid":"...","data":{...}}` | 转发并标注来源 cid |
| daemon → relay | `{"t":"msg","cid":"...","data":{...}}` | 回发给指定 cid |
| relay → client | `{"t":"msg","data":{...}}` | |
| relay → daemon | `{"t":"close","cid":"..."}` | client 断开 |
| daemon → relay | `{"t":"close","cid":"..."}` | 要求 relay 断开该 client（如鉴权失败） |
| daemon/client ↔ relay | `{"t":"hb"}` | 心跳，relay 原样回发。daemon 每 25s 一拍并验收回包（超 10s 判死链重连）；只有首拍成功才把连接视为稳定并清重试退避。普通重连采用 1–60s 随机指数退避，2min 内累计 10 次短连接时冷却 2–5min；若 relay 以 1008 明确表示另一 daemon owner 仍健康，则直接改为每 2–5min 低频探测接管。client 仅页面前台时每 25s 一拍做僵尸连接检测（旧 relay 不应答时 client 自动退化为不检测）。Worker 形态经 `setWebSocketAutoResponse` 在边缘应答（不唤醒 DO），发送串须与 `{"t":"hb"}` 逐字一致 |

relay 不解析 `data` 内容。daemon 断开时，relay 向所有 client 推 `{"t":"status","online":false}` 并保持 client 连接，等 daemon 重连后推 `online:true`。

## 2. 端到端加密信封

密码学原语（Node `node:crypto` 与浏览器 WebCrypto 均原生支持）：

- 密钥协商：X25519
- 密钥派生：HKDF-SHA256，`salt = UTF8(daemonId)`，`info = "codex-zh-remote-v1"`，输出 32 字节
- 对称加密：AES-256-GCM，12 字节随机 IV，逐消息生成
- GCM AAD 绑定方向，防反射：client→daemon 为 `UTF8("czr1:c2d")`，daemon→client 为 `UTF8("czr1:d2c")`

流程：daemon 持有长期 X25519 密钥对，公钥随配对码分发。client 每次连接生成**临时**密钥对，首帧携带临时公钥：

```json
{"v":1,"k":"<b64 client 临时公钥 raw 32B>","n":"<b64 IV>","c":"<b64 密文>"}
```

双方以 `X25519(clientEphPriv, daemonPub)` 派生本连接会话密钥；此后所有信封只含 `{"n","c"}`。daemon 长期私钥泄露前的历史流量不可解（client 侧临时密钥即弃）。

**信封序号（防中继重放，v1 兼容扩展）**：relay 零知识只保证读不懂内容，不保证不重放。
能力在**加密信道内**协商：client 在 §3.1 auth 参数里带 `caps:{seq:1}`（放明文信封字段
会被恶意中继剥离而静默降级）。支持序号的 daemon 从 auth 应答起，每个 d2c 信封带单调
递增的 `"s":n`（从 1 起，随连接重置），且 AAD 改为 `UTF8("czr1:d2c:" + s)`——序号被
篡改/剥离即认证失败。client 收到首个带 `s` 的信封后，对上行帧同样启用
（`czr1:c2d:` + 自己的计数器）。接收规则（双向同）：带 `s` 必须严格大于上一个**已验证**
帧的 `s`（允许有洞，禁止回退/重复；序号只在解密认证成功后推进，伪帧毒化不了计数器）；
一旦见过带 `s` 的帧，后续无 `s` 的帧一律视为重放拒收（daemon 断开连接，client 丢帧）。
任一端不支持时（无 `caps.seq` / 从不发 `s`）双方恒走冻结的旧 AAD 常量，完全向后兼容。

## 3. 应用层消息（信封内明文）

JSON-RPC 风格：请求 `{"id",method,"params"}`，响应 `{"id","result"| "error":{"code","message"}}`，通知无 `id`。

### 3.1 鉴权（连接后第一条，其余消息在鉴权前一律拒绝）

```json
{"id":1,"method":"auth","params":{"pairToken":"...","protocol":1}}    // 首次配对
{"id":1,"method":"auth","params":{"deviceToken":"...","protocol":1}}  // 已配对设备
```

成功：`{"id":1,"result":{"deviceId":"...","deviceToken":"...","daemonName":"...","protocol":1,"engine":"ok"|"down"}}`（配对路径签发新 deviceToken；deviceToken 路径原样确认；`engine` 为 ChatGPT/codex app-server 的当前状态，旧 daemon 不发此字段）。失败：error 后 daemon 发 `{"t":"close"}` 断开。

**能力协商（caps）**：client 在 auth 参数里带 `caps` 对象声明自身能力（走加密信道，中继剥不掉）：`seq:1` 信封序号（见 §2）、`img:1` 接收图片推送流（见 §3.2）。daemon 在成功应答里回执自身能力 `caps:{img:1,rtc:1,wl:1}`（`rtc:1` 表示支持局域网直连升级，见 §3.9；`wl:1` 表示支持 watch 租约）。观众不回执 `img/rtc`，但可回执 `caps:{wl:1}`。旧 daemon 忽略未知参数、不回执 caps，双方自然回落旧行为。

**围观（只读）设备**的成功响应额外携带 `role:"viewer"`、`scope:{sessionId,agent}`、`sessionName`（见 §3.8）——观众端据此跳过看板直进对应 agent 的会话只读视图。全权设备缺省这些字段，旧客户端忽略即可。

双方在 auth 交换应用协议版本（见 §5）。client 若发现 daemon 的 `protocol` 更高，提示用户刷新页面（PWA 拉取新代码）。

- pairToken：一次性、5 分钟时效，由 `pair` 命令生成；daemon 只存哈希。
- deviceToken：32 字节随机 base64url，daemon 只存 SHA-256 哈希与设备元数据（名称、创建时间、最后活跃）。围观设备条目另存 `role/scope/expiresAt/sessionName/muted`，以及明文 `url`（分享弹窗需要对已有链接提供"复制"；该令牌仅授权单会话只读，能读配置文件者本就能读全部会话，静态明文不引入新风险）。
- 过期（`expiresAt` 已过）与被撤销的令牌鉴权一律 403；对已在线连接，daemon 经配置文件监听与定时核对**主动踢断**（撤销/限时即时生效，不等下次鉴权）。

### 3.1a 多 Agent 路由（codex / claude）

daemon 可同时服务多个 agent 后端（`codex` 显示为 ChatGPT，`claude` 显示为 Claude Code，后者需本机装有 Claude Code CLI）。手机端首页左上角下拉切换 agent，每个会话相关请求带 `agent` 字段路由到对应后端（缺省 `codex`，向后兼容）。

```json
{"id":2,"method":"agents.list","params":{}}
// result: {"agents":[{"id":"codex","name":"ChatGPT","healthy":true},
//                    {"id":"claude","name":"Claude Code","healthy":true}]}  // 仅注册成功的后端
```

- **带 `agent` 的方法**：`sessions.list`、`projects.list`、`session.watch`、`session.send`、`session.new`、`session.start`、`session.fork`、`session.archive`、`session.unarchive`、`project.archive`、`turn.interrupt`、`goal.*`、`models.list`、`approval.respond`、`question.respond`、`share.create`、`share.list`、`share.react`。缺省 `codex`；未注册的 agent 回落 `codex`。
- `sessions.list` 应答回带 `agent` 字段确认所属后端。
- **审批跨 agent 路由**：`approval.request`/`approval.resolved` 通知携带 `agent`。审批 key 带 agent 前缀全局唯一（如 `codex-a1` / `claude-a1`，客户端视为不透明字符串）；手机端应把 `agent` 原样回填到 `approval.respond` 以直达正确的 hub，未回填时 daemon 按 key 跨 hub 兜底查找——错投至多"未命中"，不会决策错投。
- **会话条目形状按 agent 不同**：codex 是 rollout（`{timestamp,type,payload}`）；claude 是 Anthropic 消息结构（`{type:"user"|"assistant"|"system"|...,message:{role,content:[blocks]},uuid,parentUuid,cwd,...}`，块类型 `text/thinking/tool_use/tool_result`）。web 端按 `agent` 走各自独立渲染路径，不强行统一。
- **Claude 问答**：`AskUserQuestion` 的 `tool_use` 在手机端渲染为选项卡；提交走 `question.respond {sessionId,toolUseId,answers}`（`answers` 为问题文本到回答文本的映射）。daemon 将其写回仍在运行的 Claude stream-json 子进程，作为同一轮的 `tool_result`，不能降级为 `session.send` 新轮。

### 3.2 会话查看

```json
{"id":2,"method":"sessions.list","params":{"limit":50}}
// result: {"sessions":[{"id","preview","name","cwd","updatedAt","source","status",
//   "running",   // 本 daemon 正在驱动一轮
//   "active",    // 会话文件近 60s 有写入（覆盖桌面 GUI 正在跑的会话）
//   "approvals"  // 待决审批数
// }]}

{"id":3,"method":"session.watch","params":{"sessionId":"...","fromStart":true,
  "wt":"...",                          // wt 可选：watch 令牌（见下）
  "leaseMs":60000,                      // wl:1 时可选：后台推流租约
  "have":{"total":n,"ident":"..."}}}   // have 可选：断点续传游标（见下）
// result: {"ok":true,"mode":"tail"|"replay","total"?}；随后：
//   {"method":"session.snapshot","params":{"sessionId","items":[...],
//     "wt"?,        // 客户端 watch 令牌原样回打（快照与事件帧皆带；旧 daemon 无）
//     "total"?,     // rollout 全量条数（快照首片下发）
//     "ident"?,     // 文件身份指纹（首条目哈希，客户端只回传不解读；旧 daemon 无）
//     "append"?,    // true=断点续传补缺快照：客户端不清屏，条目直接续在末尾
//     "end"?}}      // true=本快照的末分片（单分片快照首片即带）
//   {"method":"session.event","params":{"sessionId","items":[...],
//     "wt"?,
//     "cont"?,      // true=快照续块（同一快照的后续分片）：历史回填而非 live 增量
//     "end"?}}      // cont 且 end=快照到此完整
//   {"method":"session.live","params":{"sessionId","event","params","wt"?}} // app-server 实时事件
{"id":31,"method":"session.watch.renew","params":{"wt":"..."}} // wl:1；同 wt 续租
{"id":4,"method":"session.unwatch","params":{"wt":"..."}} // wt 可选；旧 wt 迟到时不取消新 watch
```

**watch 令牌（wt，v1 兼容扩展）**：客户端每次 watch 领一个新的不透明令牌随参数带上，
daemon 原样打在本次 watch 产出的快照/事件帧上。快速重开同一会话时，被顶替的旧 watch
在途帧与新帧 `sessionId` 相同、客户端区分不开——凭 `wt` 丢弃旧帧（append 快照才不会
双份追加）。旧 daemon 忽略 `wt`、帧不带令牌，客户端照常放行（退回无保护的旧行为）。

**watch 租约（caps.wl，v1 兼容扩展）**：新 client 请求 60s 租约，页面前台通常每 30s 以同一
`wt` 续租；从系统冻结恢复时按真实到期时间提前续租，瞬时失败会在租期内重试。页面隐藏时立即停续租，15s 后主动 `session.unwatch`；若移动系统冻结页面导致
unwatch 未发出，daemon 在租约到期后自动停止 rollout tail 与 `session.live` 订阅。回前台
重新 watch，并用 `have` 补齐后台缺口。审批与全局看板通知不依赖会话 watch，不会被租约停掉。

**断点续传（have，v1 兼容扩展）**：客户端缓存有上次收到的 transcript 时，watch 带
`have:{total,ident}` 声明已持有 `[0,total)` 的尾部窗口（`ident` 为此前快照下发的指纹原样
回传）。daemon 校验：指纹一致、文件未缩短、缺口 ≤ 快照窗（200 条）——命中则快照只含
`[total, 新total)` 的增量并带 `append:true`；任一条不满足退回全量快照（无 `append`）。
客户端据 `cont` 区分「快照续块」与「真实 tail 追加」：前者不推进续传游标（已计入快照
首片的 `total`）、不计入 live 增量统计。**提交原子性**：`total/ident` 随快照首片先到，
但客户端须等收到 `end`（快照末分片）才把它们连同条目提交为续传凭据——中途断线丢分片
时凭据不落地，下次 watch 自然回落全量，缺洞不会固化进缓存。旧 daemon 忽略 `have`、
恒发全量且无 `end`（凭据永不提交，等价于恒全量），完全向后兼容。

`fromStart` 可选（观众回放用）：会话**已结束**（非运行且文件近 60s 无写入）时进入回放模式
（`mode:"replay"`）——首屏为开头 200 条、`total` 为全量条数，随后 `session.more` 语义变为
**向后翻页**（从上次位置继续读，`session.event` 追加，result 带 `total/done`）。会话在跑时
忽略 fromStart 回落尾部实时（`mode:"tail"`）。旧 daemon 忽略此参数且不发 `mode` 字段，
客户端按尾部模式处理即可（劣化但可用）。已知边界：回放中会话复活不自动转直播。

`items` 为 rollout JSONL 行解析后的对象（`{timestamp,type,payload}`），client 侧按类型渲染，未知类型显示摘要。每 client 连接同一时刻只 watch 一个会话。

**图片**：rollout 里内嵌的大体积 base64 图片（生成图的 `result`、用户贴图的 data URL）会被 daemon 抽出缓存（内容哈希去重，LRU 预算 32MB），条目中替换为 `imageRef: {id,mime,size}`（超出单图上限则 `{tooLarge:true}`）。

**图片推送流（caps.img，v1 兼容扩展）**：client 在 auth 声明 `caps:{img:1}` 后，daemon 在快照/tail 条目含 `imageRef` 时**主动**分块推送内容（无需逐块请求，砍掉 N 块 N 往返）：

```json
{"method":"image.chunk","params":{"id","mime","offset","data":"<b64 ≤144000 字符>","eof":bool}}
// 同一 id 按 offset 升序推完（首块 offset=0）；同连接同图推完一次后不重推。
// 切会话（新 watch）即中止在途推送（旧图块不挤占新会话首屏上行），被中止的 id
// 视作未推过，切回时整图重推（客户端收到 offset:0 重开拼装缓冲）。
// 客户端按 (id, offset) 拼装；乱序/缺块作废该缓冲，短宽限内无首块/无进展即回落
// image.fetch 拉取。观众连接不推（其通知帧走低优先级 outbox，大图会挤爆），恒走拉取。
```

拉取兜底（旧 daemon / 推送缺块 / 客户端缓存被挤出）：

```json
{"id":9,"method":"image.fetch","params":{"id":"<imageRef.id>","offset":0}}
// result: {"data":"<b64 片段，≤144000 字符>","mime","size","eof"}；offset 按 base64 字符计，循环至 eof
// 缓存不命中（daemon 重启过）返回 404，重新 watch 会话即可重建
```

单块 144k b64 字符：最坏帧 ≈ 144k×0.75（deflate 回收 base64 膨胀）×1.33（信封 base64）+ 开销 ≈ 193KB，稳在 relay 256KiB 帧上限内。

`session.live` 转发 app-server 的实时事件（`turn/started`、`turn/completed`、`item/agentMessage/delta` 等）。会话内容以 snapshot/event（rollout tail）为准；live 事件供 client 显示运行状态，避免与 tail 重复渲染。当前所有传输通道均保持 app-server 原始刷新频率；daemon 仅记录每轮原始 delta 的数量与间隔，用于评估后续是否需要中继侧合并。

Claude 后端的 live 事件由 daemon 自产：`turn/completed`、`turn/failed`、`turn/aborted`（手机中断，经 stream-json control 通道温和中止），以及 `agent_message_delta {threadId, delta}`——`claude -p --include-partial-messages` 的 stdout 打字流按 150ms 窗口合并后转发（每次 flush 对每个观看设备一帧），供 client 做流式草稿预览；正式内容仍以 tail 为准、到达即替换草稿。

### 3.3 会话操作（r0.4）

```json
{"id":5,"method":"session.send","params":{"sessionId":"...","text":"...","images":["<id>",...],
  "options":{"model":"...","effort":"low|medium|high|xhigh",
             "approvalPolicy":"untrusted|on-request|on-failure|never",
             "sandboxPolicy":{"type":"readOnly|workspaceWrite|dangerFullAccess"},
             "plan":true}}}
// daemon 内部 thread/resume（首次，幂等）+ turn/start。result: {"turnId":"..."|null}
// 发送即取得该会话操作权（谁最后发消息谁持有）
// images 可选（≤4 个）：引用此前经 image.push 上传完成的附图 id；
// text 与 images 至少有其一。daemon 把附图转成 turn/start 的 {type:"image",url:"data:..."} 输入项
// options 可选：按轮 override（daemon 白名单过滤后透传 turn/start），缺省沿用电脑端既有配置

{"id":10,"method":"models.list","params":{}}
// 代理 app-server 的 model/list（模型选择器数据源）。result:
// {"models":[{"id","name","description","efforts":["low",...],"defaultEffort","isDefault"}]}

{"id":11,"method":"goal.set","params":{"sessionId":"...","goal":"..."}}   // goal 空/缺省即清除
{"id":12,"method":"goal.get","params":{"sessionId":"..."}}                // result: {"goal":string|null}
// 会话目标（官方 App 的 Pursue goal）：daemon 代理 thread/goal/set|clear|get
```

`options.plan` 由 daemon 展开为 `turn/start` 的 `collaborationMode:{mode:"plan",settings:{model}}`（settings.model 必填，未指定模型时用引擎默认）。collaborationMode 与 thread/goal 属 app-server 的 experimental API，daemon 在 initialize 时声明 `capabilities.experimentalApi:true` 开启；旧引擎不支持时按普通错误返回。

```json

{"id":9,"method":"image.push","params":{"id":"<客户端生成>","mime":"image/jpeg","data":"<b64 片段 ≤144000 字符>","eof":bool}}
// 发消息附图的分块上传（image.fetch 的镜像方向）。同一 id 按序多次调用，eof 后由
// session.send 引用，引用即弃。result: {"ok":true}；超限（单图 12M 字符 / 连接缓冲 24M）返回 413

{"id":6,"method":"turn.interrupt","params":{"sessionId":"..."}}
// 停止进行中的轮次。result: {"ok":true|false,"reason"?}

{"id":7,"method":"session.new","params":{"cwd":"..."}}
// 新建会话（cwd 受 daemon 目录白名单约束）。result: {"threadId":"..."}

{"id":8,"method":"session.start","params":{"cwd":"...","text":"...","images":["<id>",...],"options":{...}}}
// 新建会话并发出首条消息；用于客户端草稿会话升级为真实会话。cwd 受目录白名单约束，images 复用 image.push 的临时 id。
// result: {"threadId":"...","turnId":"..."}

{"id":9,"method":"session.fork","params":{"sessionId":"..."}}
// ChatGPT/codex 后端：基于当前会话调用 app-server thread/fork 并打开新分支。result: {"threadId":"...","cwd":"..."}

{"id":10,"method":"session.archive","params":{"sessionId":"..."}}
// 归档/隐藏单个会话。ChatGPT/codex 后端调用 app-server thread/archive；Claude 后端写 daemon 本地隐藏索引。result: {"ok":true}

{"id":11,"method":"project.archive","params":{"cwd":"..."}}
// 归档/隐藏某工作目录下当前可见的全部会话。result: {"ok":true,"archived":n}

{"id":12,"method":"files.search","params":{"cwd":"...","query":"relay","limit":8}}
// 输入框 @ 文件补全的数据源：在 cwd（受目录白名单约束）内做有界模糊查找
// （跳过隐藏项与 node_modules 等产物目录，条数/深度有硬上限，结果短暂缓存）。
// result: {"files":[{"path":"src/relay-link.mjs","dir":false},...]}（目录 path 带尾斜杠）

{"id":13,"method":"commands.list","params":{"cwd":"..."}}
// 斜杠命令面板数据源：Claude 自定义命令（用户级 ~/.claude/commands + 项目级 <cwd>/.claude/commands，
// 子目录即命名空间 ns:name）。cwd 可缺省或不在白名单 → 只回用户级。
// result: {"commands":[{"name":"deploy","description":"...","hint":"[env]","scope":"user|project"}]}
// 命令文本由客户端作为普通消息发出（claude -p 的 stream-json 输入原样接收 "/name args" 并执行）
```

### 3.4 审批（r0.4）

app-server 请求命令/文件审批时，daemon **广播给所有已鉴权设备**（审批是远程任务的头号阻塞，必须在任何设备、任何页面都能立即处理）：

```json
// daemon -> 所有 client：
{"method":"approval.request","params":{"approvalKey","sessionId","kind":"command"|"fileChange","command","cwd","reason",
  "files":[{"path","kind":"add"|"update"|"delete","diff"}]|null}}  // fileChange 附文件清单与截断 diff（预算 24KB）
// 任一 client 决策（先到先得）：
{"id":8,"method":"approval.respond","params":{"approvalKey":"...","decision":"accept"|"acceptForSession"|"decline"|"cancel"}}
// 决策后 daemon -> 所有 client（其余设备卡片同步消失）：
{"method":"approval.resolved","params":{"approvalKey"}}
```

审批不设超时；无在线设备时挂起，设备（重新）鉴权成功后补发全部待决审批。

### 3.6 看板变更通知

会话运行状态或审批数变化时，daemon 向所有设备广播，客户端据此刷新列表徽标：

```json
{"method":"board.changed","params":{"sessionId","running":bool,"approvals":number}}
```

### 3.7 引擎状态通知

codex app-server 崩溃/恢复时（daemon 会自动重拉），daemon 向所有设备广播，client 用于分层连接诊断（手机↔中继 / 中继↔电脑 / ChatGPT 引擎）：

```json
{"method":"daemon.status","params":{"engine":"ok"|"down"}}
```

### 3.5 心跳

client 可发 `{"method":"ping"}`，daemon 回 `{"method":"pong"}`（信封内，兼作链路探活）。

### 3.8 围观：单会话只读链接（r1.1）

协议要点：

**权限模型（服务端强制是唯一安全边界，前端隐藏不承担安全职责）**——两个维度同时收口：

- **方法级，默认拒绝**：`role:"viewer"` 的连接仅放行 `ping`、`session.watch`（仅限
  `scope.sessionId`，越界 403；每连接频控 ≥2s，超限 429——fromStart 每次都是整文件读，
  与 `session.more` 同为读放大入口）、`session.watch.renew`、`session.unwatch`、`session.more`（每连接频控 ≥2s，超限 429）、
  `image.fetch`（仅限本会话抽出的图片，越界 403）、`share.react`。其余方法（含未来新增）一律 403。
- **数据级，推送过滤**：`approval.request/resolved`（补发与实时两条路径）与 `board.changed`
  不向观众发送；图片缓存条目记录来源会话集合（内容哈希去重，同图可属多会话）。

**铸造与管理（仅全权设备可调；观众被白名单挡在门外）**：

```json
{"id":20,"method":"share.create","params":{"agent":"claude","sessionId":"...","ttl":"24h"|null}}
// 签发单会话只读令牌并生成围观链接。ttl null 为永久。result: {"url":"...","deviceId":"..."}

{"id":21,"method":"share.revoke","params":{"deviceId":"..."}}
// 仅可撤销 role:"viewer" 条目（全权设备撤销走桌面设备页，协议面不扩权）。
// 撤销即删条目并立即断开该链接的全部在线连接。result: {"ok":true}

{"id":22,"method":"share.list","params":{"agent":"claude","sessionId":"..."}}
// 分享弹窗数据源：该会话现存的围观链接。
// result: {"links":[{"deviceId","url","createdAt","expiresAt","muted","viewers"}]}
```

**围观链接载荷**沿用 `#d=` 机制（见 §4），追加仅供观众端 UI 的显示提示字段：
`ro:1`（只读标记）、`sid`（会话 id）、`sname`（会话名，截断 ≤20 字）、`agent`（目标 agent，旧链接缺省 `codex`）。
**权限判定一律以 daemon 端设备条目为准，链接内字段仅是显示提示。**

**围观层互动**（观众输入只进 daemon 自己的通知广播，与 rollout/turn 完全不同路，
**绝不进入会话与 agent 上下文**；所有互动可被创作者按链接静音）：

```json
{"id":23,"method":"share.react","params":{"agent":"claude","emoji":"👏"}}
// 喝彩。表情枚举（👏🔥❤️😂🤯），枚举外 400；每连接令牌桶（突发 5、平均 2/s）超限 429。
// 观众的 sessionId/agent 取自 scope；全权设备需带 params.sessionId 与当前 agent。静音链接的 react 返回
// {ok:true} 但静默丢弃（不给刷子反馈面）。daemon 按会话×表情做 1s 合并窗口后广播：
{"method":"share.reaction","params":{"sessionId","emoji","count"}}
// -> 该会话观众 + 全部全权设备。计数为窗口内合并值，内存态、不持久化。

{"id":24,"method":"share.mute","params":{"deviceId":"...","muted":true}}
// 仅全权：按链接静音全部互动（防打扰是底线）。result: {"ok":true}

{"method":"viewer.count","params":{"sessionId","count","congested"?}}
// 观众进出时防抖广播（500ms）。观众收 {sessionId,count}（"同场 N 人"）；
// 全权额外收 congested：观众帧持续积压 >3s 置真、恢复置假，翻转时补发。

{"method":"share.summary","params":{"sessionId","deviceId","visitors","peak","reactions"}}
// 围观战报：链接撤销/过期时发给全权设备（visitors 累计到访、peak 并发峰值、
// reactions 喝彩数）。撤销/到期时观众已离线也会补发（设备表核对时对账）。
// 内存态，daemon 重启即清；没人来过的链接不发。
```

预留（v1.x，仅全权可调）：`share.say`（创作者对观众广播旁白，渲染为与会话内容
视觉区隔的气泡；瞬时消息，不持久化）。

**规模与稳态**：观众人数不设产品上限。daemon 侧观众通知帧走低优先级发送队列（按 relay
上行水位排空，饱和时延迟/丢弃观众帧：尾部模式经快照追平，回放模式从丢弃点按序补发、
无重无漏）——审批与全权设备帧永远先行。
熔断背板：单会话并发观众按 `scope.sessionId` 聚合（跨该会话全部链接），超过
`viewerLimit`（默认 100，可配置）时新观众鉴权 403，文案诚实说明原因；仅防病态场景。

旧缓存 PWA 打开围观链接：会渲染完整操作 UI，但一切越权调用被 daemon 拒绝——劣化但安全。

### 3.9 局域网直连（WebRTC DataChannel）

手机与电脑同网时把数据面从中继热切换到点对点直连：省中转延迟，外网抖断时局域网内
照常工作。**中继连接永远是先建立的主通道**——它承担信令、daemon 在线状态与回落路径；
直连是锦上添花，任何失败都静默回落，绝不影响主路径。

**信令（一次往返，vanilla ICE）**：client 在已鉴权的中继连接上调用：

```json
{"id":30,"method":"rtc.offer","params":{"type":"offer","sdp":"..."}}
// result: {"type":"answer","sdp":"..."}
// daemon 未开启直连（配置 rtcDirect:false）时返回 501；观众连接被方法白名单挡住（403）
```

双方 SDP 都携带收集完毕的全部 candidate（无 trickle 帧）。双方都不配 STUN/TURN——
只有 host/mDNS candidate，同网直连，跨网自然协商失败（client 静默作罢、退避重试）。
daemon 每信令连接同时只保留一个未完成协商（重发 offer 顶掉旧的）；并发 PeerConnection
有上限（默认 8），DataChannel 打开后 60s 内未完成鉴权、或任意 5 分钟无入站帧即回收。

**直连通道上的语义**：DataChannel 打开后，其上传输的是**裸 E2E 信封**（无中继的
`{"t":"msg"}` 包装），信封格式、序号防重放、压缩协商与 §2 逐字节一致。对 daemon 而言
直连是一个全新的客户端连接：client 须重新完成 E2E 握手（新临时密钥）并以 deviceToken
重新鉴权——**直连的信任锚仍是配对时钉死的 daemon 公钥，与 DTLS 层证书无关**。单消息
上限沿用中继的 256 KiB（daemon 在 SDP 里通告 `max-message-size`，与浏览器缺省一致）。

**切换与回落**（client 侧约定）：auth 回执带 `caps.rtc:1` 才发起升级（旧 daemon 不被
打搅）；直连鉴权成功后有状态操作（session.watch 等）迁到直连（中继侧先
`session.unwatch`），中继连接保持不断，广播类通知两通道都会到达、client 按键幂等去重。
直连断开立即把 watch 迁回中继并退避重试。直连活性靠应用层 `ping`/`pong`（§3.5，仅前台）。

## 4. 配对码

`pair` 命令输出 URL：`https://<web>/#p=<base64url(JSON)>`，JSON：

```json
{"v":1,"relay":"wss://...","id":"<daemonId>","pk":"<b64 daemon 公钥>","name":"<电脑名>","tok":"<pairToken>"}
```

client 解析后连接 relay、完成 §2 握手、以 `tok` 走 §3.1 配对，成功后本地持久化 `{relay,id,pk,name,deviceToken}`（多台电脑各存一份）。

## 5. 版本

三层各自独立版本化，允许 daemon / PWA / relay 分别升级：

- **relay 转发协议**：连接 URL 前缀 `/v1/`（如 `/v1/daemon/<id>`）。不兼容改动用 `/v2/`；官方 relay 需同时挂载新旧 path，旧 daemon 连 `/v1/` 继续可用。relay 对未知 `t` 帧忽略不断开，保证旧 relay 兼容新端加的帧类型。
- **E2E 信封格式**：首帧 `v:1`（见 §2）。加密握手格式变更时递增。
- **应用协议**（daemon ↔ client）：常量 `APP_PROTOCOL`，在 §3.1 auth 双向交换。
  - client 发现 `daemon.protocol > 自己` → 提示刷新页面（PWA 自动拉新代码，成本低）。
  - daemon 遇到更高的 client protocol → 按自己能力响应（向前兼容：客户端不应假设新方法存在）。
  - 新增方法/字段属兼容变更，不递增；仅当移除或改变既有语义时递增。
