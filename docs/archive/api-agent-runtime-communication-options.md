# API 与 Agent Runtime 通信方案评估

## 背景

当前 `api <-> agent runtime` 主要通过 Redis 通信。  
现阶段的核心问题不是性能，而是**安全边界**：

- agent runtime 是不可信执行环境，理论上“什么都能做”
- 如果 agent 拿到 Redis 地址/凭证，可能越权读写与自身通信无关的数据
- 同时 runtime pod 数量较多，不适合简单把所有 agent 长连接都压到 API 上

另外需要明确：

- **流式输出只是中间态展示**
- **最终结果仍以 agent -> API 的持久化为准**
- 因此流式链路可以接受短暂中断，不必追求最强可靠

## 设计目标

1. **agent 不直接访问共享 Redis 数据面**
2. **指令下发链路可靠**
3. **流式输出链路低延迟、可中断**
4. **支持大量 runtime pod**
5. **尽量复用现有 API / Redis / SSE 架构**
6. **便于渐进迁移**

## 结论概览

当前最值得考虑的方案主要有 3 个：

### 方案 A：Agent Gateway + Redis
### 方案 B：MQTT 下行 + Agent 上行流式到 API/Relay
### 方案 C：MQTT 统一 Agent 通信总线

另有一个过渡方案：

### 方案 D：继续 Redis，但做强隔离

---

# 方案 A：Agent Gateway + Redis

## 结构

```text
API <-> Redis <-> Agent Gateway <-> WebSocket <-> Agent
API -> SSE -> Client
Agent -> HTTP POST API 做最终持久化
```

## 思路

- agent 不再直接连接 Redis
- agent 只连接一个可信的 `agent-gateway`
- `agent-gateway` 负责：
  - 管理 agent 长连接
  - 从 Redis 读取 API 下发命令并转发给 agent
  - 接收 agent 流式事件并写回 Redis
- API 和前端 SSE 侧基本保持现有模型

## 优点

- 最贴近现有架构，改造成本较低
- 直接解决 agent 拿 Redis 凭证的问题
- API 不需要直接承接大量 agent 长连接
- 可以渐进式替换现有方案

## 缺点

- 需要新增一个有状态连接服务
- 需要自己处理连接归属、ACK、心跳、重连等逻辑
- 长期看本质上是在自研一个轻量 broker

## 评价

**短中期最现实、最推荐。**

---

# 方案 B：MQTT 下行 + Agent 上行流式到 API/Relay

## 结构

```text
API -> MQTT -> Agent
Agent -> WebSocket / Streaming POST -> API or Realtime Relay
API / Relay -> Redis 临时缓存 -> SSE -> Client
Agent -> HTTP POST API 做最终持久化
```

## 思路

把通信拆成三条链路：

1. **可靠控制链路**：API -> MQTT -> agent
2. **弱可靠流式链路**：agent -> API/relay
3. **最终一致链路**：agent -> API 持久化

## 优点

- 语义最清晰：控制、流式、持久化完全分层
- 下行命令通过 MQTT 解决大量 runtime 的路由问题
- 流式只是中间态，API/relay 短暂重启可接受
- agent 不再碰 Redis

## 缺点

- 需要引入 MQTT
- 架构组件会比方案 A 更多
- 如果上行流仍进 API，则 API 还要承接 agent 上行连接

## 评价

**理念很清晰，适合作为中期目标方案。**

---

# 方案 C：MQTT 统一 Agent 通信总线

## 结构

```text
API <-> MQTT <-> Agent
API/Relay 订阅 Agent Event -> SSE -> Client
Agent -> HTTP POST API 做最终持久化
```

## 思路

- Agent 相关通信统一走 MQTT
- MQTT broker 负责承接大量 runtime 长连接、topic 路由、ACL、会话

## 优点

- 最适合大量 runtime pod 的长期形态
- 不需要自研太多连接/broker 能力
- topic ACL 比 Redis key ACL 更适合 runtime 级隔离
- API 多副本更友好

## 缺点

- 引入新基础设施
- 迁移成本高于方案 A
- 需要完整设计 topic、ACL、QoS、会话策略

## 评价

**长期平台化最优，但不是短期最省力。**

---

# 方案 D：继续用 Redis，但做强隔离

## 结构

不改总体交互模型，但强化隔离：

- agent-comm 专用 Redis 实例
- 尽量不混业务无关数据
- ACL / 分片 / 代理层做风险收敛

## 优点

- 改造最小
- 与当前系统兼容性最高

## 缺点

- 根问题没有彻底消失
- 只要 agent 仍直连底层 Redis，安全边界仍弱于 gateway / MQTT
- 对于大量动态 runtime，云 Redis 上做细粒度 ACL 并不理想

## 评价

**可作为过渡方案，不建议作为长期目标。**

---

# 不优先推荐的方案

## API 直接连接所有 Agent（WebSocket）

虽然可行，但不适合当前前提：

- runtime pod 数量多
- API 会承接大量 agent 长连接
- 多副本下连接归属复杂
- API 会变成连接管理中心

因此**不作为优先方案**。

---

# 推荐顺序

## 推荐 1：Agent Gateway + Redis

适合作为下一步最现实的演进方案。

**原因：**
- 最贴现状
- 改造面可控
- 直接解决 agent 直连 Redis 的安全问题
- API / Client 侧改动小

## 推荐 2：MQTT 下行 + Agent 上行流式

适合作为更清晰的目标架构。

**原因：**
- 能把“可靠控制”和“中间态展示”彻底拆开
- 很符合当前业务语义

## 推荐 3：MQTT 统一总线

适合作为长期平台化方向。

**原因：**
- 大规模 runtime 下更标准
- 长期维护成本可能低于自研 gateway

---

# 最终建议

如果现在要选一个**最可能实际落地**的方案：

## 建议优先采用：
# **Agent Gateway + Redis**

作为当前架构的自然演进：

- 让 agent 从 Redis 中解耦
- API 继续复用现有 Redis / SSE 模型
- 后续再根据规模和复杂度，决定是否演进到 MQTT

---

# 一句话总结

> 短中期最务实的方案是 **Agent Gateway + Redis**；  
> 中长期更清晰的演进方向是 **MQTT 负责可靠控制链路**，甚至进一步演进为 **MQTT 统一 Agent 通信总线**。
