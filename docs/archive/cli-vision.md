# Cohub CLI Vision

本文档用于记录 Cohub 未来统一 CLI 的设想。

请注意，CLI 不是一个独立产品，而是 Cohub 整体平台能力的统一入口。它服务于：

> **Workspace 托管 + 云端 Runtime 运行 + 本地到云端的开发/部署工作流**

也就是说，Cohub CLI 不应只是一些零散脚本的集合，而应成为：

- 本地开发入口
- Runtime 运维与调试入口
- Workspace push / deploy 入口
- Gateway / Channel 管理入口
- 平台诊断入口

---

## 1. 为什么要有统一 CLI

当前仓库已经有：

- 根脚本 `scripts/dev.mjs`
- `apps/api` / `apps/gateway` / `apps/agent` / `apps/web` 各自的 dev/build/start 脚本
- 各类文档中描述的 Runtime / Workspace / Channel / Provisioning 能力

但随着项目继续发展，只靠 package scripts 会越来越不够：

- 本地开发命令分散
- Runtime 调试入口不统一
- 部署和运维命令难以标准化
- 后续很难做 doctor / logs / attach / inspect 等工具化能力

因此，长期上 Cohub 需要一个统一 CLI，例如：`cohub`。

---

## 2. CLI 的角色定位

建议把 `cohub` CLI 看作三层入口的统一壳：

### 2.1 开发入口
面向 Cohub 平台开发者。

例如：

- `cohub dev`
- `cohub dev api`
- `cohub dev web`
- `cohub dev gateway`
- `cohub build`
- `cohub typecheck`
- `cohub lint`

### 2.2 平台运维入口
面向 Runtime / Gateway / Workspace 的运维、排障与观察。

例如：

- `cohub runtime logs <runtimeId>`
- `cohub runtime inspect <runtimeId>`
- `cohub runtime attach <runtimeId>`
- `cohub runtime events <runtimeId>`
- `cohub workspace inspect <workspace>`
- `cohub gateway logs`
- `cohub gateway status`

### 2.3 用户工作流入口
面向未来“本地 workspace -> 云端 Cohub”工作流。

例如：

- `cohub login`
- `cohub workspace init`
- `cohub workspace link`
- `cohub workspace push`
- `cohub runtime start`
- `cohub deploy`
- `cohub channel connect`

---

## 3. 我们希望 CLI 提供什么体验

## 3.1 单一入口
不要长期依赖大量散落脚本；应该有统一入口：

```bash
cohub <command> [subcommand] [options]
```

## 3.2 子命令按领域组织
建议按平台对象分层：

- `cohub workspace ...`
- `cohub runtime ...`
- `cohub session ...`
- `cohub channel ...`
- `cohub gateway ...`
- `cohub dev ...`
- `cohub doctor`
- `cohub logs ...`

这样更贴合 Cohub 的领域模型，而不是按实现细节拆命令。

## 3.3 既适合人，也适合脚本
CLI 输出建议同时支持：

- 默认人类可读输出
- `--json` 机器可读输出
- 清晰 exit code
- stderr/stdout 分离

后续不管是 shell automation、CI 还是其它工具集成都会更稳。

## 3.4 面向排障设计
后续一定会需要：

- `cohub doctor`
- `cohub runtime logs`
- `cohub runtime inspect`
- `cohub runtime events`
- `cohub gateway doctor`

也就是说，CLI 不能只覆盖 happy path。

---

## 4. 建议的命令结构（草案）

以下是一个初步命令结构草案。

```bash
cohub login
cohub whoami

cohub dev
cohub dev api
cohub dev web
cohub dev gateway
cohub dev all

cohub workspace init
cohub workspace link
cohub workspace push
cohub workspace pull
cohub workspace inspect <workspace>
cohub workspace list

cohub runtime start <workspace>
cohub runtime stop <runtimeId>
cohub runtime inspect <runtimeId>
cohub runtime logs <runtimeId>
cohub runtime events <runtimeId>
cohub runtime attach <runtimeId>
cohub runtime list

cohub session list --runtime <runtimeId>
cohub session fork <sessionId> --from-message <messageId>
cohub session inspect <sessionId>

cohub channel list
cohub channel connect <provider>
cohub channel inspect <channelId>

cohub gateway dev
cohub gateway status
cohub gateway logs

cohub deploy
cohub doctor
```

---

## 5. CLI 设计原则（建议）

## 5.1 领域优先，不要实现优先
命令应该围绕：

- workspace
- runtime
- session
- channel

而不是围绕：

- redis
- pod
- internal api
- script file

底层实现可以变，但领域对象应该稳定。

## 5.2 默认安全、显式高风险
对于可能危险的命令：

- 删除 runtime
- 清理 workspace
- 直接执行远端操作
- 导出敏感配置

应要求显式确认或 `--yes`，并注意日志脱敏。

## 5.3 输出应可观察
长任务应支持：

- 进度输出
- 结构化状态
- 失败时给出下一步建议

例如 Runtime provisioning 失败时，不要只输出一个 error string，而应该提示：

- Pod 是否创建成功
- Redis 是否就绪
- Agent 是否报告 running
- 建议查看哪些日志/事件

## 5.4 为未来多 profile / 多环境预留空间
后续可能会有：

- 本地 dev 环境
- 测试环境
- 生产环境
- 不同 Cohub endpoint

因此 CLI 最好从一开始就预留：

- `--profile`
- `--endpoint`
- `--token`
- `--json`

---

## 6. 与 OpenClaw 可借鉴的地方

OpenClaw 在 CLI 入口层有很多值得借鉴的点：

- 单一入口
- 帮助 / 版本 fast path
- 运行时环境抽象
- 输出与日志体系分离
- 面向运维和排障的命令设计
- 逐步从脚本演化到产品化 CLI

但 Cohub 不应直接复制 OpenClaw 的命令集合，因为两者产品中心不同：

- OpenClaw 是 personal AI assistant / local-first gateway
- Cohub 是 workspace hosting / cloud runtime platform

所以更适合借鉴的是：

- CLI 架构思路
- 入口治理方式
- 日志 / 输出 / JSON 模式
- doctor / inspect / logs 设计理念

而不是直接照搬具体命令语义。

---

## 7. 分阶段推进建议

## 阶段 1：统一开发入口
先把零散脚本收束到统一入口。

目标示例：

- `cohub dev`
- `cohub dev api`
- `cohub dev web`
- `cohub dev gateway`

## 阶段 2：补运维与排障命令
围绕 Runtime / Gateway 增加：

- `runtime logs`
- `runtime inspect`
- `runtime events`
- `doctor`

## 阶段 3：补用户工作流命令
围绕 Workspace / Runtime / Channel 增加：

- `workspace init/link/push`
- `runtime start/stop`
- `channel connect`

## 阶段 4：补自动化友好能力
增加：

- `--json`
- 稳定 exit code
- profile / endpoint 支持
- 非交互模式

---

## 8. 当前结论

当前最值得先做的，不是一次性把 CLI 做大，而是：

1. 明确 CLI 在 Cohub 中的长期角色
2. 用统一入口逐步替换零散 scripts
3. 优先补齐 Runtime / Gateway 观察与排障命令
4. 为未来本地 workspace -> 云端 Cohub 工作流留出命令结构

一句话：

> **Cohub CLI 应成为平台领域模型的统一入口，而不是脚本集合的别名层。**
