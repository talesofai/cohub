# 技术分享提纲：Cohub 当前技术架构

本文档用于技术团队内部分享，目标是：

- 帮助团队快速建立对项目当前架构的统一认知
- 以 **Workspace 托管 + 云端 Runtime 运行** 为主线讲清楚系统设计
- 帮助 API / Web / Agent / Gateway / Infra 同学对齐边界

建议分享时长：**25 ~ 40 分钟**。

---

# 0. 开场：一句话说明 Cohub 是什么

建议开场直接讲：

> **Cohub 是一个以 Workspace 托管为核心、支持在云端启动 Runtime 并持续运行 Agent 的平台。**

然后补一句：

> 它不是一个单纯的聊天系统，也不是一个单纯的代码托管系统，而是把 Workspace、Runtime、Agent、Channel 串起来的云端运行平台。

---

# 1. 第一部分：项目核心主线

## 要讲的重点

先别从 Session 开始，先从平台主资产讲：

1. **Workspace 是平台核心资产**
   - 可托管
   - 可版本化
   - 可分享
   - 可被启动为 Runtime

2. **Runtime 是 Workspace 的云端运行实例**
   - 用户真正进入的是 Runtime
   - Runtime 承载生命周期、运行状态、Channels、Sessions

3. **Session 是 Runtime 内部的上下文组织方式**
   - 不是平台的第一主语
   - 是 Runtime 内的执行上下文容器

## 建议展示文档
- `docs/terminology.md`
- `docs/runtime-session-model.md`

## 建议展示图
### 图 1：平台主关系
来自：`docs/runtime-session-model.md`

讲法建议：
- 先讲 Workspace 和 Agent
- 再讲 Runtime 是如何由 Workspace 启动出来的
- 再讲 Session 只是 Runtime 内部的执行组织方式

---

# 2. 第二部分：整体系统架构

## 要讲的重点

这一部分回答：

> 整个系统里有哪些组件，它们分别承担什么职责？

## 建议顺序

### 2.1 Web
- 负责控制台
- 管理 Workspace / Runtime / Session Graph 页面
- 不直接连 Runtime Pod
- 一律通过 API

### 2.2 API
- 控制平面
- 负责编排 Runtime
- 负责 Session 持久化
- 负责 Channel 路由
- 负责对接 Agent / Gateway

### 2.3 Agent Supervisor
- 运行在 Runtime Pod 内部
- 封装 Pi coding agent
- 消费 Redis prompt
- 输出运行事件
- 持久化 assistant message

### 2.4 Gateway
- 负责外部 provider 接入
- Discord / Telegram / Feishu 等统一走这里

### 2.5 Redis / PostgreSQL / K8s / Gitea / Pi
- Redis：实时流
- PostgreSQL：结构化持久化
- K8s：Runtime Pod 生命周期
- Gitea：Workspace repo 托管
- Pi：Runtime 内部执行引擎

## 建议展示文档
- `docs/technical-architecture.md`

## 建议展示图
### 图 2：总体架构图
来自：`docs/technical-architecture.md`

讲法建议：
- 先横向讲“谁是入口、谁是控制平面、谁是执行平面”
- 再强调 Workspace repo / Gitea 在主链路中的位置
- 最后讲 Pi 只存在于 Runtime 执行层，不是平台核心资产本身

---

# 3. 第三部分：当前运行时模型

## 要讲的重点

这一部分重点讲 Runtime / Session / Message / Fork / Channel 的关系。

## 建议顺序

### 3.1 Runtime
- 一个云端运行实例
- 拥有生命周期、Channels、Sessions

### 3.2 Session
- Runtime 内部的独立线性上下文
- 一个 Runtime 下可以有多个 Session

### 3.3 Message
- Session 内线性消息记录
- 可作为 fork 锚点

### 3.4 Fork
- 从某个 Session 的某条 Message 创建新的 Session
- 用 Session graph 表达 lineage

### 3.5 Channel
- 外部通信入口
- 先挂 Runtime，再通过 binding 路由到 Session

## 建议展示文档
- `docs/runtime-session-model.md`

## 建议展示图
### 图 3：Runtime / Session / Message 关系图
### 图 4：Session Graph 图
### 图 5：Channel Binding 图

## 建议讲法
- 不要先讲 API，先讲语义
- 强调“Channel 路由到 Session，不是 Message”
- 强调“Graph 的主体是 Session，Message 是 fork 锚点”

---

# 4. 第四部分：关键链路

这一部分建议是分享的主体，最容易让团队对齐。

---

## 4.1 链路一：创建 Runtime

### 要讲的重点
- 从 Workspace 到 Runtime 的启动链路
- Provisioning 如何工作
- Runtime Pod 如何被拉起

### 建议展示图
#### 图 6：创建 Runtime 时序图
来自：`docs/technical-architecture.md`

### 建议讲法
1. Web 调 API 创建 Runtime
2. API 写 runtime / root session
3. API 解析 Workspace repo
4. API 通过 K8s 创建 Pod
5. Pod 启动 Agent Supervisor
6. Supervisor 通过 Redis 报告 running

### 建议强调
> Runtime 是 Workspace 的云端执行实例，不是一次临时对话。

---

## 4.2 链路二：Session 发消息

### 要讲的重点
- 用户消息如何从 Web 进入 Agent
- assistant 输出如何实时回流并最终落库

### 建议展示图
#### 图 7：Session 发消息时序图
来自：`docs/technical-architecture.md`

### 建议讲法
1. Web 发消息到 API
2. API 先写 user message
3. API 投递 Redis prompt
4. Agent Supervisor 消费 prompt
5. Pi session 执行 prompt
6. 实时事件进 Redis output stream
7. Web 通过 SSE 看实时输出
8. turn_end 后，Agent 调 API 持久化 assistant message

### 建议强调
- Redis 负责实时流
- PostgreSQL 负责最终状态
- Web 看实时输出不是直接连 Pod，而是通过 API + Redis stream

---

## 4.3 链路三：Session Fork

### 要讲的重点
- 为什么 fork 是新的 Session，而不是 session 内 branch
- fork 如何同时在控制平面和执行平面对齐

### 建议展示图
#### 图 8：Session fork + Pi 对接时序图
来自：`docs/technical-architecture.md`

### 建议讲法
1. 用户在某条 message 上点击 fork
2. API 创建 child Session
3. API 复制到 source message 为止的线性历史
4. child Session 第一次被真正使用时，Agent 请求 bootstrap
5. Agent 找 parent Pi session file
6. Agent 基于 source Pi entry 提取 branch
7. Agent 重建 child Pi session file，并对齐 child session id

### 建议强调
> DB Session 和 Pi session file 尽量一一对应，这是当前执行面设计的关键约束。

---

## 4.4 链路四：Channel Inbound / Outbound

### 要讲的重点
- 外部 provider 为什么不直接接 API
- bindingKey 为什么绑定 Session

### 建议讲法
#### Inbound
1. Provider -> Gateway
2. Gateway -> Redis inbound stream
3. API 消费 inbound
4. API 根据 `(runtimeChannelId, bindingKey)` 找 Session
5. 创建 user message
6. enqueue prompt 给 Agent

#### Outbound
1. assistant message 落库
2. API 查该 Session 的 bindings
3. dispatch outbound 到 Gateway
4. Gateway 发回 provider

### 建议强调
> 外部 conversation 是持续消息流，所以应该绑定 Session，而不是 Message。

---

# 5. 第五部分：数据库模型

## 要讲的重点

这一部分回答：

> 数据库里到底存了什么？这些表分别服务于平台哪个层面？

## 建议顺序

### 5.1 主链路表
- `workspaces`
- `agents`
- `runtimes`

### 5.2 Runtime 内部运行态表
- `runtime_sessions`
- `session_messages`
- `session_tool_calls`

### 5.3 通信路由表
- `user_channels`
- `runtime_channels`
- `runtime_session_bindings`

## 建议展示文档
- `docs/db-schema.md`

## 建议展示图
### 图 9：数据库 ER 图
### 图 10：Session lineage 图

## 建议强调
- schema 的主线是 Workspace -> Runtime
- Session 只是 Runtime 内部组织方式
- `protocolMessageId` 是 Pi 对接关键字段

---

# 6. 第六部分：为什么这套模型适合团队协作

## 要讲的重点

### 6.1 语义稳定
- Workspace：托管资产
- Runtime：云端执行实例
- Session：Runtime 内独立上下文
- Message：线性记录
- Fork：创建新 Session

### 6.2 控制平面 / 执行平面分离清晰
- API：编排 + 持久化
- Agent Supervisor：执行 + Pi session 管理
- Gateway：provider 集成

### 6.3 实时流与最终状态分离清晰
- Redis：实时流
- PostgreSQL：最终状态

### 6.4 易于扩展
当前模型天然适合后续扩展：
- 更强的 Session Graph UI
- thread 自动 fork
- Runtime suspend / resume
- Workspace 文件同步与回写

---

# 7. 收尾总结

## 建议最后 1 分钟总结

可以直接用下面这段话收尾：

> Cohub 当前的核心架构可以概括为：
> 平台托管 Workspace，并从 Workspace 启动云端 Runtime；
> Runtime 在 K8s 中运行，由 API 负责编排、由 Agent Supervisor 在 Pod 内执行；
> Runtime 内通过多个线性 Session 组织上下文，Session 可以从某条 Message fork 出新的 Session；
> Web 和外部 Channel 都通过 API 和 Gateway 接入，Redis 负责实时流，PostgreSQL 负责最终状态，Pi 负责底层 Agent 执行。

---

# 8. 分享时建议引用的文档顺序

如果你分享时要现场打开文档，建议顺序如下：

1. `docs/README.md`
2. `docs/terminology.md`
3. `docs/runtime-session-model.md`
4. `docs/technical-architecture.md`
5. `docs/db-schema.md`
6. `docs/agent-infra-design.md`
7. `docs/use-cases.md`

---

# 9. 一页版提纲（适合做目录页）

```text
1. Cohub 的核心：Workspace 托管 + 云端 Runtime 运行
2. 整体系统架构：Web / API / Agent / Gateway / Redis / PG / K8s / Gitea / Pi
3. Runtime 模型：Runtime / Session / Message / Fork / Channel
4. 关键链路：创建 Runtime、发消息、Session Fork、Channel 路由
5. 数据模型：Workspace -> Runtime 主链路 + Runtime 内部运行态
6. 团队协作边界：控制平面、执行平面、实时流、最终状态
```
