# 中继请求额度治理方案

状态：已实现并完成验证
更新时间：2026-07-16
适用范围：Cloudflare Worker 官方中继与 Node 自托管中继

## 1. 结论

本次额度异常不是正常转发消息增长造成的，而是一个不带 `inst` 的旧 daemon 在已有健康 owner 时反复连接。2026-07-14 的观测结果为：

- 官方 Worker `codex-zh-relay` 约 36,977 次调用；
- 同账号另一 Worker `readup` 约 11,846 次调用；
- `daemon_rejected` 36,886 次，其中同一个 daemonId 占 36,874 次；
- 实际上下行消息约 7,628 条、约 15.4 MB；
- Durable Object 约 81,989 次调用。

上述 Worker 与 Durable Object 执行量合计约 130,812，足以解释账号级 100,000 次/日提醒。邮件反映的是账号内 Workers/Pages Functions 的请求执行量，不是用户可见的“转发消息条数”；最终计量仍以 Cloudflare Usage 页面为准。

旧 daemon 会先完成 WebSocket 升级，再收到 1008 关闭。旧版客户端在 `open` 时清空退避，因而形成约 2 秒一次的连接风暴。最终治理方案是：

1. 旧 daemon（缺少有效 `inst`）与健康 owner 冲突时，在 WebSocket 升级前直接返回 HTTP 409；
2. 当前 daemon 继续在 101 升级后收到明确冲突信号，但 Worker 改用 `owner_conflict` 协议帧，避免升级响应返回前的 1008 被边缘吞掉；Node/旧 relay 的 1008 保持兼容；
3. 冲突告警使用 Durable Object 持久化冷却，首次立即通知，同一 daemonId 一小时内不重复通知；
4. Worker 和 Node 自托管实现保持一致。

该方案针对的是历史客户端造成的意外重试风暴，不替代认证、恶意流量防护或付费套餐的容量保障。

## 2. 目标与非目标

### 目标

- 阻止旧 daemon 在冲突路径上完成 WebSocket 升级，避免每次失败都产生已接受又关闭的连接生命周期；
- 不改变当前版本 daemon 的自动接管能力和 2–5 分钟冲突冷却；
- 让运营方在旧客户端开始冲突时及时收到一次通知，同时避免告警风暴；
- 保持正常转发、心跳、休眠恢复、同实例重连和 stale owner 接管行为不变；
- 让官方 Worker 与 Node 自托管中继具有相同的 owner 冲突决策。

### 非目标

- 不通过“停放”被拒绝的 WebSocket 降低重试；这会制造假在线并长期占用资源；
- 不依赖 `Retry-After`；Node WebSocket API 不向现有 daemon 暴露握手响应状态或响应头；
- 不在本轮引入 KV、D1、Cron 或新的基础设施；
- 不用 Cloudflare Free 的 IP 限流替代 owner 判断；共享出口/NAT 会带来误伤，而且不能按 daemonId 精确计数；
- 不在本轮更换 daemonId、增加安装身份 UI 或设计完整握手认证协议；
- 不把升级 Workers Paid 视为根因修复。付费套餐只能作为后续容量保险。

## 3. 最终连接决策

`relay/owner.mjs` 继续作为 Worker 和 Node 的共享决策源。实现时将现有二值结果收敛为清晰的三种动作，或提供等价的共享辅助函数，避免两个传输实现各自推导：

| 场景 | 动作 | 对客户端的结果 |
| --- | --- | --- |
| 无健康 owner | `replace` / 接入 | 正常 101 升级 |
| 相同有效 `instanceId` | `replace` | 关闭旧 socket，新连接接管 |
| owner 已过 60 秒新鲜期 | `replace` | 新连接接管 |
| 不同且有效的 `instanceId`，owner 健康 | `reject-websocket` | 101 后发送 `owner_conflict` 拒绝帧，当前 daemon 主动关闭并进入 2–5 分钟探测；兼容 Node/旧 relay 的 1008 |
| 无有效 `instanceId`，owner 健康 | `reject-http` | 升级前返回 HTTP 409，旧 daemon 的 15 秒建连超时进入普通退避 |

健康 owner 的判定仍使用最近自动心跳时间；首拍尚未发生时使用 `openedAt` 提供新连接宽限。不得仅凭 socket 存在就永久阻止接管。

## 4. Worker 实现方案

### 4.1 延迟创建 WebSocketPair

`BaseRelayRoom.fetch()` 当前在解析角色后立即构造 `WebSocketPair`。实现时必须改为：

1. 解析 URL、role、daemonId 和 `inst`；
2. 对 daemon 查询现有健康 owner 并获得共享连接动作；
3. 若动作是 `reject-http`，先记录拒绝事件，然后直接返回 `new Response(null, { status: 409 })`；
4. 只有需要正常接入或需要向当前 daemon 发送拒绝帧时，才构造 `WebSocketPair`。

`reject-http` 路径不得调用 `acceptWebSocket`，不得创建 `rejected-daemon` 标签，也不得触发后续 WebSocket close 生命周期。这样才能真正减少拒绝路径的资源开销，而不是仅改变关闭码。

### 4.2 以显式拒绝帧保留当前 daemon 的冲突语义

有效 `inst` 与健康 owner 不同时，接受专用的 rejected socket，然后发送 `{"t":"reject","reason":"owner_conflict"}`。当前 daemon 收到后主动关闭并进入 2–5 分钟低频接管探测。不能在返回 101 前立即关闭：Wrangler 与生产边缘验证均可能只交付 `open`、不交付 1008。daemon 仍兼容 Node/旧 relay 的 1008 / `daemon already connected`。

### 4.3 拒绝原因进入观测层

`daemonRejected` hook 增加明确的 `reason`，至少区分：

- `legacy_owner_conflict`：旧 daemon 的升级前 409；
- `owner_conflict`：当前 daemon 的显式拒绝帧或兼容的 1008。

Analytics Engine 始终记录拒绝事件及原因。统计层不得通过 `version === unknown` 反推原因，因为版本缺失与 `inst` 缺失不是同一语义。

## 5. Node 自托管中继的一致性

`relay/node/server.mjs` 必须在调用 `upgradeConnection()` 前完成 daemon 路径的 owner 判断：

- `reject-http`：直接向原始 socket 写入最小 HTTP 409 响应并关闭，不创建 WebSocket 连接对象；
- `reject-websocket`：Node 自托管保持升级后关闭 1008；Worker 在升级后发送显式拒绝帧；
- `replace`：完成升级并替换旧连接。

client 路径不改变。Node 与 Worker 必须调用同一个共享 owner 动作函数，避免自托管环境出现不同冲突语义。

## 6. 告警与去重

仅 `legacy_owner_conflict` 触发运营告警。告警状态保存在对应 Durable Object 的 storage 中：

- key：`legacyConflictNotifiedAt`；
- 冷却：1 小时；
- 第一次冲突或冷却到期后：先写入新的时间戳，再发送 Telegram；
- 冷却内的后续冲突：继续写 Analytics Engine，但不再通知。

顺序必须是 `storage.get` → 判断 → `storage.put` → Telegram。Durable Object 的 storage input/output gates 用于避免并发冲突重复通知；不能用内存变量，因为 DO 可能在两次旧客户端重试之间休眠。

hook 继续通过 `state.waitUntil()` 异步执行。storage、Analytics Engine 或 Telegram 的任何失败都只记录日志并 fail-open，不得改变 409 响应、健康 owner 或正常转发。

通知只包含 daemonId、app、OS、国家/地区、版本和拒绝原因等连接元数据，不包含消息内容、令牌或端到端加密信封。

## 7. 容量效果与剩余风险

本地真实运行时验证表明，Durable Object 返回 HTTP 409 时，Node WebSocket 会很快触发 `error`，但 3 秒内不会触发 `close`，并保持 `CONNECTING`。现有 daemon 的 15 秒建连超时会最终终止连接并进入重试。

对历史客户端，单次失败节奏约为：

```text
15 秒建连超时 + 0–15 秒旧版随机退避 = 15–30 秒一次
```

单个持续冲突的旧实例预计约 2,880–5,760 次尝试/日；若随机退避近似均匀，均值约 3,840 次/日。相比事故中的 36,874 次拒绝，预计下降约 84%–92%。这不是零请求：每次尝试仍会命中 Worker 与 Durable Object。多个克隆配置、持续扫描或主动攻击仍可能聚合消耗配额，后续若再次出现异常，应另立认证与滥用防护方案。

每次旧冲突最多产生一次 storage read；按单实例 2,880–5,760 次/日估算，显著低于本次事故的拒绝事件量。告警写入按一小时冷却最多 24 次/daemonId/日。

## 8. 代码与文档影响面

计划修改：

- `relay/owner.mjs`：提供共享的三态连接动作；
- `relay/worker/src/relay-core.mjs`：延迟创建 pair，增加升级前 409 和拒绝原因；
- `relay/node/server.mjs`：在 upgrade 前执行旧 daemon 的 409；
- `internal/relay-worker/src/stats.mjs`：记录拒绝原因并实现持久化告警冷却；
- `public/PROTOCOL.md`：补充 legacy 409、当前 daemon 显式拒绝帧与兼容 1008 的语义；
- `test/relay-link.test.mjs`、`test/relay-node-owner.test.mjs` 及 Worker 集成测试：覆盖下列验收矩阵。

daemon 重试逻辑增加 `owner_conflict` 拒绝帧处理，并保留现有 1008 兼容路径；15 秒建连超时、首拍心跳后才清退避、60 秒指数退避上限和短连接风暴冷却保持不变。

## 9. 验收矩阵

### 连接决策

- 无 owner 时，legacy 与当前 daemon 均正常接入；
- 相同 `instanceId` 正常替换旧 socket；
- 不同有效 `instanceId` 对健康 owner 得到显式拒绝帧（Node/旧 relay 为 1008），并进入 2–5 分钟探测；
- legacy 对健康 owner 得到 HTTP 409，且 409 分支在 `WebSocketPair` 构造前返回；
- legacy 409 不产生 daemon open、daemon close 或 client close 事件；
- owner 过新鲜期后，legacy 与当前 daemon 均可接管。

### 真实运行时

- 使用 Wrangler/Miniflare 真实 Durable Object 验证 409 能穿透 Worker stub；
- 使用项目支持的 Node WebSocket 运行时验证 409 触发 `error`、不触发 `open`，并由 15 秒建连超时推进重试；
- 验证失败握手不会清空重试退避；
- Node 自托管中继同样在升级前返回 409。

### 告警与故障

- 第一次 legacy 冲突立即写入冷却并通知；
- 一小时内重复冲突只记录 Analytics Engine；
- DO 休眠/重建后冷却仍有效；
- 并发 legacy 冲突只产生一次通知；
- storage、Analytics Engine、Telegram 分别失败时，连接决策与健康 owner 均不受影响。

### 回归

- 正常 daemon/client 转发和 256 KiB 上限；
- 心跳自动应答与 owner 新鲜度；
- Durable Object hibernation socket restoration；
- epoch 递增、client 在线状态、stale owner 接管；
- 官方 Worker 与 Node 自托管语义一致。

## 10. 上线与回滚

1. 完成单元、Node 集成和真实 Wrangler 握手测试；
2. 执行 `wrangler deploy --dry-run`，确认 official entrypoint 与 DO migration 未发生意外变化；
3. 部署官方 Worker；
4. 使用专用合成 daemonId 验证：健康 owner + legacy 得到 409，健康 owner + 当前不同实例收到 `owner_conflict` 并主动关闭；
5. 观察 Analytics Engine、DO 调用量和错误率至少 30 分钟；
6. 保留上一版 Worker deployment，若正常接入、client 转发或 owner 接管出现回归，立即回滚。

上线验收标准：

- legacy 冲突路径没有 101、没有 accepted rejected socket；
- 单个持续冲突的旧实例稳定在 120–240 次尝试/小时（均值目标约 160 次/小时），而不是秒级风暴；
- 当前 daemon 的显式拒绝帧、1008 兼容路径与 2–5 分钟接管探测均正常；
- 同一 daemonId 的 legacy 告警不超过 1 次/小时；
- 正常转发、心跳、休眠恢复和 stale owner 接管测试全部通过。

若只看到请求下降但未验证正常接入和 stale owner 接管，不视为上线成功。

## 11. 实施结果

2026-07-16 已完成：

- 共享三态 owner action、Worker legacy 升级前 409、Node 自托管一致行为；
- `daemon_rejected` 原因字段与 legacy 冲突的一小时持久化 Telegram 冷却；
- 协议说明、连接矩阵测试、Worker `owner_conflict` 帧、Node HTTP 409/1008 测试和内部告警测试；
- 全量 `npm test`：93/93 通过；
- `npm run check:schema` 通过；
- Wrangler 4.111.0 真实本地 Durable Object：健康 owner + legacy 返回 409；不同当前实例收到 `{"t":"reject","reason":"owner_conflict"}`；同实例 replacement 能建立新连接；
- Node WebSocket 真实运行时：409 后由现有 15 秒 connect timeout 推进重试；
- 官方与公开 Worker 的 `wrangler deploy --dry-run` 均通过。

Wrangler 本地模拟器和生产边缘都没有可靠交付“101 返回前立即 close”的 1008。Worker 已改为显式 `owner_conflict` 帧，daemon 收到后主动关闭；Node 自托管继续用已验证可交付的 1008。生产部署后仍须按第 10 节使用合成 daemonId 验证拒绝帧实际送达，再判定上线完成。
