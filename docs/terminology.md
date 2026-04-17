# Terminology

本文档定义 Cohub 当前统一使用的技术术语。

## Space

**Space** 是由 Agent + Sandbox 启动出来的运行实例。

Space 是用户在控制台中真正“进入”的对象。

### 它是什么
- K8s Pod / Sandbox / Redis IO 的拥有者
- Channel 的绑定目标
- 一个或多个内部 Session 的容器

### 它拥有
- 生命周期状态（pending, provisioning, ready, stopped, error, terminated）
- 运行环境
- 外部输入输出通道（Channel）
- 内部 Session 集合
- 文件系统（通过 Space FS API 访问）

### 它不是什么
- 不是静态项目
- 不是单一对话上下文
- 不是 Git 仓库

---

## Workspace

**Workspace** 是项目托管、版本管理、分享与部署的核心单元。

它对应一个 Git 仓库。

### 它是什么
- 一个可版本化的项目单元
- 一个可托管的云端资产
- 一个可被他人 fork / 复用的工作单元

### 它不是什么
- 不是运行中的实例
- 不是会话对象
- 不是外部通信入口

---

## Agent

**Agent** 是运行在 Space 中的 AI 执行体。

### 它是什么
- 负责执行任务的 AI / Agent 逻辑
- 负责调用模型、工具和文件系统的执行体
- 运行在 Sandbox Pod 内

### 它不是什么
- 不是整个项目容器
- 不是 Space 生命周期本身

---

## Session

**Session** 是 Space 内部的独立会话上下文容器。

> **Session 内消息线性；分叉通过 fork 生成新的 Session。**

### 它是什么
- 独立的 LLM / Agent 对话上下文
- 一个可持续追加消息的线性会话
- 一个可被 Channel 路由绑定的目标
- 一个可能从其它 Session 的某条 Message fork 出来的子 Session

### 它拥有
- 线性消息历史
- tool call 记录
- token / cost 统计
- lineage 关系（parentSessionId, forkedFromMessageId）

### 它不是什么
- 不是外层 Space
- 不是 message tree
- 不是 branch 的别名

---

## Message

**Message** 是 Session 内部的线性消息记录。

### 它是什么
- Session 历史中的一条消息
- role / content / model / usage / error 的载体
- Session fork 时的锚点

### 它当前的角色
- 只属于一个 Session
- 在 Session 内按 sequence 线性排序
- 可作为 fork 的 source message

### 它不是什么
- 不是独立会话容器
- 不是 Channel binding 的目标
- 不是树节点（当前设计下）

---

## Session Fork

**Session Fork** 指从某个 Session 的某条 Message 开始，创建一个新的 Session。

### 它是什么
- 一种创建子 Session 的方式
- 一种 lineage 关系
- 一种"从某条历史消息开始继续，但不污染原 Session"的机制

### 它不是
- 不是 Session 内部 branch
- 不是 message tree 分叉

---

## Session Graph

**Session Graph** 是 Space 内多个 Session 之间的父子关系图。

图上的：
- **节点** = Session
- **边** = parentSessionId
- **边的锚点说明** = forkedFromMessageId 对应的 Message 摘要

虽然我们有时会说它"看起来像 message graph"，但在数据建模上：

> **Graph 的主体仍然是 Session，Message 只是 fork 锚点。**

---

## Channel

**Channel** 是外部通信入口或通信端点。

例如：
- Web
- Discord
- Telegram
- Feishu

### 它是什么
- 用户向 Space 发送输入的入口
- Space 向外发送输出的出口
- 一种外部集成面

### 它不是什么
- 不是 Space
- 不是 Session
- 不是 Message

---

## Space Channel

**Space Channel** 指一个用户配置好的 Channel 被挂载到某个 Space 上。

也就是：

```text
user_channel -> space_channel
```

它表达的是：
- 这个 Space 可以通过该 Channel 收发消息

---

## Space Session Binding

**Space Session Binding** 是外部 conversation key 到内部 Session 的路由关系。

也就是：

```text
(spaceChannelId, bindingKey) -> spaceSessionId
```

### 它解决的问题
- 同一个 Space Channel 下，不同 external chat / thread / topic 应该路由到哪个 Session

### 它为什么绑定 Session 而不是 Message
因为：
- Message 只是历史记录和 fork 锚点
- Session 才是持续承接后续消息流的上下文容器

---

## 一句话规则

如果有歧义，统一按下面规则判断：

> **Space 是你运行的实例。Session 是实例中的会话。Message 是会话中的线性记录。Fork 是从某条 Message 创建新 Session。Channel 始终路由到 Session。**
