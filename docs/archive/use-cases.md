# Use Cases

本文档从产品和技术结合的视角，描述 Cohub 当前架构最适合承接的典型场景。

请始终记住，项目的核心是：

> **Workspace 托管 + 云端 Agent 运行**

因此，Runtime、Session、Channel 都是为了让 Workspace 可以在云端被持续运行、调试和协作，而不是为了把系统抽象成一个纯会话平台。

当前项目已经统一采用：

- Runtime 作为外层运行实例
- Session 作为 Runtime 内部的独立线性上下文
- 所有分叉通过 fork Session 实现
- Channel 永远路由到 Session

因此下面所有 use case 都应按这套模型理解。

---

## 1. Workspace 托管后直接启动云端 Runtime

### 场景
开发者把项目以 Workspace 形式托管在平台上，然后：
- 选择某个 Workspace
- 启动 Runtime
- 在云端直接运行 Agent
- 通过控制台观察运行过程

### 技术价值
- 让 Workspace 不只是一个代码仓库，而是可直接被启动的云端运行单元
- 让 Runtime 成为 Workspace 的执行实例
- 减少本地环境依赖，提升协作和复用效率

### 对应技术链路
- Workspace 存在于 Gitea
- Web -> API -> create runtime
- API -> K8s -> Runtime Pod
- Runtime Pod 挂载 / clone Workspace
- Agent 在 Pod 内运行

---

## 2. 浏览器中的 Runtime 调试与交互

### 场景
开发者在 Web 控制台中：
- 创建 Runtime
- 等待 Runtime Pod 启动
- 在 Runtime 页面里与某个 Session 聊天
- 实时看到模型输出和工具执行情况

### 技术价值
- 让 Runtime 成为可观察、可交互、可长时间运行的云端执行实例
- Session 提供 Runtime 内部的独立上下文
- SSE + Redis stream 提供实时输出体验

### 对应技术链路
- Web -> API -> create runtime
- API -> K8s -> Pod
- Web -> Session message API -> Redis prompt
- Agent -> Redis output -> Web SSE

---

## 3. 从历史消息 fork 出新的 Session

### 场景
用户在某个 Session 的某条历史消息上，认为：
- 想尝试另一种思路
- 不想继续污染原 Session
- 希望保留当前 Runtime 环境，但从某条消息开始重新展开

此时用户点击 fork，得到一个新的 Session。

### 技术价值
- 让 Runtime 内部的探索路径更清晰
- 让从某条历史消息继续工作成为一等能力
- 更容易与底层 Pi session file 对齐

### 对应技术链路
- Web -> `POST /api/sessions/:id/fork`
- API 创建 child Session，复制线性历史
- Agent 首次加载 child Session 时，对接 Pi fork

### UI 表达
- Runtime 页面里从某条 message 触发 fork
- Session Graph 页面展示 lineage 和 fork source message preview

---

## 4. 同一个 Runtime 下的多 Session 并行工作

### 场景
同一个 Runtime 下，用户可能同时维护多个上下文：
- root Session：主工作流
- Session A：从某条设计消息 fork 出来的探索路径
- Session B：从另一条问题分析消息 fork 出来的排障路径

### 技术价值
- Runtime 作为“Workspace 在云端运行出来的工作容器”
- Session 作为 Runtime 内部的独立执行路径
- 允许在同一运行实例内保留多个上下文，而不是每次都新开 Runtime

### 对应技术要求
- Runtime 下多个 Session 列表
- Session 独立 message history
- Session graph 可视化

---

## 5. 外部 Channel 的异步任务闭环

### 场景
用户通过 Discord / Telegram 等外部 Channel 与 Runtime 交互：
- Agent 在外部渠道推送结果
- 用户回复继续任务
- Runtime 持续推进下一步

### 技术价值
- 用户不必一直停留在 Web 控制台
- Runtime 可以在云端长时间存在
- Session 作为稳定路由目标，天然适配外部 chat / thread 的持续对话语义

### 对应技术链路
- Provider -> Gateway -> Redis inbound -> API
- API -> `(runtimeChannelId, bindingKey) -> session`
- API -> Redis prompt -> Agent
- Agent -> API persistence -> Gateway outbound -> Provider

---

## 6. 外部 thread / topic 映射为新的 Session

### 场景
一个外部主对话已经绑定到某个 Session。  
用户基于其中某条消息，在外部平台开启了新的 thread / topic / 子会话。

长期目标语义是：
- 原对话继续对应原 Session
- 新 thread 对应一个新的 Session
- 新 Session 记录它是从原 Session 的哪条 Message fork 出来的

### 技术价值
- 外部 conversation boundary 与内部 Session boundary 对齐
- 避免同 Session 内复杂 branch 语义
- 更适合 Discord thread / Slack thread 等平台

### 当前状态
- 基础 Session fork 和 graph 已具备
- provider-specific 自动识别与自动 fork 还可继续增强

---

## 7. Runtime 内部长期工作与多轮推进

### 场景
某些任务不是一次对话完成，而是：
- Runtime 在云端持续跑
- 用户中间回来查看状态
- 在原 Session 或 fork 出的新 Session 中继续推进

### 技术价值
- Runtime 提供长生命周期执行环境
- Session 提供 Runtime 内部长期上下文容器
- Session graph 使团队能理解这些上下文是如何演化出来的

---

## 8. Session Graph 作为 Runtime 解释工具

### 场景
在团队协作或复杂任务排查时，需要解释：
- 当前 Runtime 下有哪些 Session
- 哪些 Session 是从哪条消息衍生的
- 为什么会出现多个平行上下文

### 技术价值
- Session Graph 成为 Runtime 运行历史的可视化解释层
- 比 message tree 更适合讲解“任务路径”
- 更符合 git-like 心智模型

### 当前实现方式
- 独立页面 `/runtimes/:id/graph`
- 节点是 Session
- 边来自 `parentSessionId`
- fork 来源说明来自 `forkedFromMessageId` 对应 message 摘要

---

## 9. Workspace 作为长期资产，Runtime 作为执行实例

### 场景
开发者把 Workspace 托管在平台上，然后：
- 创建 Runtime
- 在 Runtime 内打开多个 Session 做调试和探索
- 未来把结果继续沉淀回 Workspace 或其衍生版本

### 技术价值
- Workspace 是长期托管资产
- Runtime 是云端执行实例
- Session 是 Runtime 内部的上下文演化单元

这也是当前项目最根本的产品结构。

---

## 10. 为什么当前模型适合技术团队协作

当前模型对团队协作很友好，因为：

### 1. 项目主线清晰
- Workspace 托管是主资产
- Runtime 是主执行对象
- Session 是 Runtime 内部组织方式

### 2. 概念简单
- Runtime 是容器
- Session 是独立上下文
- Message 是线性记录
- Fork 是创建新 Session

### 3. 责任边界清晰
- API 管编排和持久化
- Agent 管执行和 Pi session
- Gateway 管外部 provider
- Web 管控制台和可视化

### 4. 适合逐步增强
在不改动核心模型的前提下，可以继续加：
- provider-specific thread fork
- 图形化 graph UI
- Runtime suspend/resume
- Web 作为标准 channel

---

## 11. 一句话总结

> Cohub 当前最核心的 use case，是托管 Workspace，并从 Workspace 启动云端 Runtime；Runtime 在云端持续运行 Agent，并在其内部维护多个可 fork 的线性 Session，通过 Web 和外部 Channel 持续协作推进任务。 
