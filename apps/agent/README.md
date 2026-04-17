# Agent Sandbox Supervisor (@cohub/agent)

这是 Cohub 的 Sandbox 守护进程（Supervisor）。它主要负责在隔离容器中启动并管理 `pi-coding-agent`，并通过 Redis Streams 与主后端 `apps/api` 进行双向流式交互。

## 目录结构

- `src/index.ts`: 守护进程核心入口，负责初始化环境、处理 Redis I/O，并驱动 Agent Session。
- `Dockerfile`: 构建用于 K8s Sandbox 隔离环境运行的轻量级镜像。

## 运行方式

当前 `apps/agent` 使用 **Bun** 作为本地开发与运行时入口：

```bash
# 开发模式
cd apps/agent
bun run dev

# 构建
bun run build

# 类型检查
bun run typecheck

# 运行构建产物
bun run start
```

## 镜像与环境设计

当前镜像采用精简的 **Bun runtime** 方案：
1. **基础镜像**：基于 `oven/bun`。
2. **构建方式**：使用 `bun install` 安装依赖，使用 `tsc` 构建 TypeScript 输出。
3. **运行环境**：保留 Python、git、ripgrep、fd、ffmpeg、字体等 Agent 常用系统依赖。
4. **浏览器依赖**：当前 `apps/agent` 本身不再直接依赖 `playwright`，镜像中也不再安装 Playwright 浏览器。

## 核心流控机制 (Redis)

守护进程通过 Redis 与 API 服务通信：
- 输入队列：`cohub:sessions:{id}:input_queue`
- 处理中队列：`cohub:sessions:{id}:processing_queue`
- 死信队列：`cohub:sessions:{id}:dead_letter_queue`
- 输出流：`cohub:sessions:{id}:output_stream`
- 元信息：`cohub:sessions:{id}:meta`

## 镜像构建与本地测试

### 1. 执行构建
在**项目根目录**下运行：

```bash
docker build -f apps/agent/Dockerfile -t cohub-agent:latest .
```

### 2. 本地 Redis 测试运行

```bash
# 启动本地 Redis
docker run -p 6379:6379 -d redis:7

# 准备一个测试工作区
mkdir -p test-workspace

# 运行 Sandbox 镜像
docker run --rm -it \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  -e SESSION_ID="test-001" \
  -v $(pwd)/test-workspace:/workspace \
  cohub-agent:latest
```

> Linux 用户请将 `host.docker.internal` 替换为主机真实的局域网 IP 或 Docker 网关 IP。
