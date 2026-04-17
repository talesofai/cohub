# gateway-streams-review-and-migration-notes.md

## 适用范围

这份文档**不是**在描述整个系统所有 Redis / Stream 的全局改造。

它只描述本次针对下面这条链路做的调整：

- `Gateway -> API` 的 inbound 事件链路
- `API -> Gateway` 的 outbound 命令链路
- `Gateway -> API` 的 logs 链路

也就是这几个 stream：

- `stream:gateway:inbound`
- `stream:gateway:outbound`
- `stream:gateway:logs`

不包含：

- runtime 内部的 `runtimes:{runtimeId}:*`
- agent 输入输出 stream / queue
- 其它 Redis key 的全局规范化

---

## 本次改动目标

这次调整主要解决两个问题：

1. `gateway` 相关 stream 没有长度限制，可能无限增长
2. inbound / outbound 仍然使用简单 `XREAD`，不利于多实例消费

因此本次改动只做了两类优化：

- 为特定链路的 stream 增加 `MAXLEN`
- 将特定链路的消费方式改成 `Consumer Group`

同时刻意**没有**引入：

- 定时任务
- 自动 claim / 重试
- 死信队列
- 复杂补偿逻辑

这是一个偏“清爽、可上线、易运维”的版本。

---

## 改动后的链路

### 1. Gateway inbound

外部平台事件进入 Gateway 后：

```text
Provider -> Gateway -> stream:gateway:inbound -> API
```

- Gateway 负责 `XADD`
- API 负责 `XREADGROUP`
- API 成功或失败后都会 `XACK`

当前语义：**at-most-once**

也就是说：

- 优点：坏消息不会卡住整条队列
- 代价：处理失败的消息不会自动重试

---

### 2. Gateway outbound

API 生成对外发送命令后：

```text
API -> stream:gateway:outbound -> Gateway -> Provider
```

- API 负责 `XADD`
- Gateway 负责 `XREADGROUP`
- Gateway 成功或失败后都会 `XACK`

当前语义同样是：**at-most-once**

---

### 3. Gateway logs

Gateway 的日志事件：

```text
Gateway -> stream:gateway:logs -> API -> DB
```

- Gateway 负责 `XADD`
- API 负责 `XREADGROUP`
- API 写库成功后 `XACK`
- 写库失败时暂不 ACK，允许后续排查 pending

相比 inbound / outbound，这条链路更偏“可观测性”用途。

---

## 涉及的 Stream

### `stream:gateway:inbound`

用途：Gateway 将标准化后的入站事件发送给 API。

生产者：
- Gateway

消费者：
- API consumer group: `api-inbound-consumers`

本次改动：
- 增加 `MAXLEN ~ 10000`
- 从 `XREAD` 改成 `XREADGROUP`

---

### `stream:gateway:outbound`

用途：API 将出站命令发送给 Gateway。

生产者：
- API

消费者：
- Gateway consumer group: `gateway-outbound-consumers`

本次改动：
- 增加 `MAXLEN ~ 10000`
- 从 `XREAD` 改成 `XREADGROUP`

---

### `stream:gateway:logs`

用途：Gateway 将日志事件发送给 API，再由 API 落库。

生产者：
- Gateway

消费者：
- API consumer group: `api-loggers`

本次改动：
- 增加 `MAXLEN ~ 10000`
- 保持 consumer group 消费，并统一 group 命名

---

## Consumer Group 一览

### API inbound

- stream: `stream:gateway:inbound`
- group: `api-inbound-consumers`

### Gateway outbound

- stream: `stream:gateway:outbound`
- group: `gateway-outbound-consumers`

### API logs

- stream: `stream:gateway:logs`
- group: `api-loggers`

---

## 设计取舍

### 为什么没有加自动重试 / DLQ

因为这次目标不是做一个“强可靠消息系统”，而是先把以下问题解决：

- stream 无限制增长
- 多实例下消费模型不合适
- 服务重启后 consumer group 初始化不稳

为了控制复杂度，本次故意没有引入：

- pending claim
- 重试次数管理
- dead letter queue
- 定时扫描任务

后续如果业务上确认需要“失败消息一定要保留/重放”，再单独补第二阶段方案。

---

### 为什么 inbound / outbound 失败也 ACK

这是当前版本的明确取舍。

原因：

- 避免单条坏消息长期阻塞整个队列
- 保持实现简单
- 降低运维复杂度

因此这两条链路当前是：

- **at-most-once**
- 不是 at-least-once
- 也不是 exactly-once

如果后续要升级可靠性，需要额外引入：

- 不 ACK 的失败保留
- pending reclaim
- 或 DLQ

---

## 幂等性处理

本次对 consumer group 初始化做了最小幂等处理。

即：

- 首次启动时创建 group
- 后续重启时如果 group 已存在，不报错退出

否则会出现典型问题：

- 第一次启动成功
- 第二次重启因为 `BUSYGROUP` 报错
- 监听协程无法启动

---

## 相关代码位置

### API

- `apps/api/src/redis.ts`
- `apps/api/src/index.ts`
- `apps/api/src/channels.ts`
- `apps/api/src/gateway-logs.ts`

### Gateway

- `apps/gateway/src/redis.ts`
- `apps/gateway/src/bus.ts`
- `apps/gateway/src/index.ts`

---

## 运维检查

### 查看 stream 信息

```bash
redis-cli XINFO STREAM stream:gateway:inbound
redis-cli XINFO STREAM stream:gateway:outbound
redis-cli XINFO STREAM stream:gateway:logs
```

### 查看 consumer group

```bash
redis-cli XINFO GROUPS stream:gateway:inbound
redis-cli XINFO GROUPS stream:gateway:outbound
redis-cli XINFO GROUPS stream:gateway:logs
```

### 查看 pending

```bash
redis-cli XPENDING stream:gateway:inbound api-inbound-consumers
redis-cli XPENDING stream:gateway:outbound gateway-outbound-consumers
redis-cli XPENDING stream:gateway:logs api-loggers
```

### API 内部指标

```bash
curl http://<api-host>/internal/metrics
```

---

## 上线前建议

如果环境里还没有正式数据，建议先清理相关 stream：

```bash
redis-cli DEL stream:gateway:inbound
redis-cli DEL stream:gateway:outbound
redis-cli DEL stream:gateway:logs
```

然后按顺序重启：

1. API
2. Gateway

并确认：

- API 能正常创建/复用 inbound、logs consumer group
- Gateway 能正常创建/复用 outbound consumer group
- `/internal/metrics` 能看到 stream 长度和 pending

---

## 后续可以继续做什么

如果后面要继续优化这条链路，可以分两步：

### Phase 2：增强可靠性

只针对这几个 gateway stream，增加：

- pending reclaim
- 失败不 ACK
- dead letter queue
- 手工重放工具

### Phase 3：进一步统一

把 API / Gateway 两边关于 stream 的：

- 常量命名
- helper
- metrics 输出结构
- consumer 初始化模式

再做一轮更彻底的统一。

注意，这些仍然是**针对 gateway 相关链路**的优化，不代表全局 Redis 结构都会一起改。
