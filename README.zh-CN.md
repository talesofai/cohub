# Cohub

*Your own space to create, play, and build with people and agents.*

Cohub 是一个让人和 Agent 共同创作的 living Space。随处开始，用任何媒介创作，并沉淀为可分享的 Works。

它结合了：
- 以浏览器为中心的 Space，用于对话、文件、会话、任务和预览
- 基于 Checkpoint 的保存、派生与复用
- 支持文本、图像、视频和音乐的多模态生成
- 可发现、可分享的公共 Spaces 和 Works
- 让人和 Agent 都能随时行动的 CLI 与外部 Channel

## 核心理念

### Fun to start
打开一个 Space，马上开始玩想法、提示词、文件和 Agent。

### Build together
人和 Agent 在同一份上下文里。共创、保存、分享。

### Open everywhere
Web、移动端、CLI、Discord、WeChat，Space 会跟着你走。

### Powerful for real work
游戏、应用、媒体、自动化、自定义主页——从随手玩到正式产出。

### Never start blank
从一个 Checkpoint fork 出新的 Space，或在 session 里用 `@space` 引用任意 Space 作为上下文。

## 核心概念

### Space
Space 是 Cohub 的主要创作界面。

它是一个实时、隔离的环境，人和 Agent 会在其中一起工作。Space 会把对话、文件、草稿、输出和实验放在同一个地方。

### Checkpoint
Checkpoint 是从 Space 中保存出来的不可变快照。

它记录一个有价值的时刻，可以被分享、派生、恢复，也可以作为新工作的稳定基准。

### Agent
Agent 是在 Space 中执行协作的主动角色。

### Session
Session 是 Space 中的一个对话上下文。每个 Session 都保留自己的历史，并可以独立演化。

### Channel
Channel 是连接到 Space 的外部入口。

例如 Web、Discord、Telegram、飞书和 WeChat。人可以通过这些入口发起交互，Agent 也可以通过这些入口回传结果。

### Sandbox
Sandbox 是 Space 背后的执行环境。

它提供运行能力，但不作为产品表层的主要概念。

## 产品定位

Cohub 的核心思路是：**人先在 Space 里创作，真正有价值的上下文再保存为 Checkpoint**。

这个平台适合：
- 在实时 Space 中和人、Agent 一起创作
- 将阶段性成果保存为 Checkpoint
- 基于 Checkpoint Fork 出新的 Space 继续探索
- 从文件、目录或端口发布 Works
- 通过 CLI 和 API 用同一套产品能力自动化操作

> Cohub 是一个让人和 Agent 一起创作、保存、分享，并基于真实上下文继续构建的共享创作空间。

## 仓库结构

```text
cohub/
├── apps/
│   ├── api/          # Hono API — 编排、Provisioning、Session 持久化
│   ├── agent/        # Agent 控制服务 — 运行 Pi coding agent，连接 sandbox
│   ├── sandbox/      # Sandbox 执行器 — Go WS server，负责 workspace / fs / process
│   ├── gateway/      # 外部 Channel 网关（Discord、Telegram、飞书、WeChat 等）
│   ├── web/          # SvelteKit Web 应用
│   └── worker/       # 任务调度器 — 定时任务与异步任务处理
├── deploy/           # 各环境部署配置
├── docs/             # 架构说明、使用指南与示例
├── packages/
│   ├── billing/              # Billing provider 抽象
│   ├── cli/                  # @neta-art/cohub-cli
│   ├── core/                 # 服务端共享领域逻辑
│   ├── db/                   # Drizzle schema 与数据库辅助
│   ├── identity/             # 鉴权 / 身份辅助
│   ├── infra/                # 基础设施辅助（Redis、存储、遥测）
│   ├── protocol/             # 跨应用共享类型与协议（private）
│   ├── sandbox-client/       # Agent 侧 sandbox WS 客户端
│   ├── sandbox-controller/   # Sandbox 供给控制器
│   └── sdk/                  # @neta-art/cohub 客户端 SDK
├── scripts/          # 工具脚本
└── README.zh-CN.md
```

## 技术栈

- **语言**：TypeScript + Go
- **前端**：SvelteKit
- **后端**：Hono
- **Agent Runtime**：pi-coding-agent（WS 客户端，连接 sandbox）
- **Sandbox Runtime**：Go + WebSocket server
- **数据库**：PostgreSQL + Drizzle ORM
- **基础设施**：Kubernetes (ACK)
- **包管理**：pnpm monorepo

## 开发

```bash
pnpm install
pnpm dev
```

### 质量检查

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## 文档

产品文档（Web）：
- 中文：[cohub.run/docs/zh](https://cohub.run/docs/zh)
- English：[cohub.run/docs](https://cohub.run/docs)

产品文档内容源：
- `docs/product/zh/`
- `docs/product/en/`

仓库内工程说明仍保留：
- `docs/self-hosting.md`
- `docs/agent-sandbox-runtime.md`
- `docs/language-intelligence.md`
- `docs/works-guide.md`
- `docs/work-commerce-guide.md`
- `docs/generations.md`
- `docs/space-hooks.md`
- `docs/examples/` — generation 声明、Work capability lab 等示例

## 开源说明

- 许可证：Apache License 2.0（Viscept Limited）
- Billing 默认关闭；配置 `TALESOFAI_BILLING_*` 后可启用官方托管计费 provider
- OpenTelemetry 远程导出默认关闭，需显式配置 `OTEL_EXPORTER_OTLP_*`
- 部署请复制 `deploy/**/values.example.yaml` 为本地 `values.yaml`
- 自托管指南：`docs/self-hosting.md`
- 安全报告：`SECURITY.md` 或 `dev@talesof.ai`

## License

Apache License 2.0 © Viscept Limited
