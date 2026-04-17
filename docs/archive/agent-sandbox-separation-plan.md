# Agent 与容器（Sandbox）分离重构方案

## 1. 现状 Review

### 1.1 当前架构

```
┌──────────────────────────────────────────────────┐
│              K8s Pod (Runtime Container)         │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │        apps/agent (Supervisor)             │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  @mariozechner/pi-coding-agent       │  │  │
│  │  │  - 内置 tools (bash/read/write/etc)  │  │  │
│  │  │  - 直接操作本地文件系统               │  │  │
│  │  │  - 直接执行 shell 命令               │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  │  Redis I/O │ API Persistence │ Session Mgr │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  系统工具: git, python, ripgrep, ffmpeg, etc.   │
│  挂载: /workspace, /sessions, /public            │
└──────────────────────────────────────────────────┘
```

**核心问题：**

| 问题 | 描述 | 影响 |
|------|------|------|
| **紧耦合** | Agent (Pi) 直接在容器内操作文件系统，tools 和执行环境耦合在一起 | 无法替换 Agent 引擎、无法支持多后端 |
| **职责混乱** | 容器既是执行沙箱，又运行 Supervisor 逻辑，还包含 Agent 引擎 | 单一镜像职责过多，Dockerfile 臃肿 |
| **不可替换** | 如果想换掉 Pi Coding Agent 换成其他 LLM Agent 框架，需要重写整个 Supervisor | 锁定在单一 Agent 实现 |
| **安全边界模糊** | Agent 有完整的文件系统访问权限，没有抽象的安全边界 | 无法做精细权限控制 |
| **镜像体积大** | 容器需要包含所有系统工具 + Node.js + Agent 依赖 | 冷启动慢、资源占用大 |

### 1.2 参考架构 (open-agents)

```
┌─────────────────────────────────────────────────────────────┐
│                     Web / Gateway                            │
│              (Auth, Session, UI, API Orchestration)          │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼─────────┐    ┌──────────▼──────────┐
    │  packages/agent   │    │  packages/sandbox   │
    │  (Agent Logic)    │    │  (Execution Backend)│
    │                   │    │                     │
    │  - ToolLoopAgent  │    │  - Sandbox Interface│
    │  - Tools (抽象)   │◄──►│  - Vercel impl      │
    │  - Subagents      │    │  - Cloud impl       │
    │  - System Prompt  │    │  - Local impl       │
    │  - Context Mgmt   │    │  - exec/readFile/   │
    │                   │    │    writeFile/stat   │
    └───────────────────┘    └─────────────────────┘
```

**关键设计模式：**

```
Agent Tools ──► Sandbox Interface ──► Concrete Backend
                      ▲
                      │
              experimental_context: { sandbox }
```

Tools 不再直接操作文件系统，而是通过 `experimental_context.sandbox` 获取 `Sandbox` 实例，调用其抽象方法：

```typescript
// Tool 内部（与后端无关）
const sandbox = await getSandbox(experimental_context, "read");
const content = await sandbox.readFile(absolutePath, "utf-8");

// Sandbox Interface
interface Sandbox {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf-8"): Promise<void>;
  exec(command: string, cwd: string, timeoutMs: number): Promise<ExecResult>;
  stat(path: string): Promise<SandboxStats>;
  // ...
}
```

---

## 2. 目标架构

### 2.1 核心思想

> **容器只提供标准操作工具（Sandbox），Agent 是独立运行的工作负载。**

```
┌─────────────────────────────────────────────┐
│          K8s Pod (Sandbox Container)        │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Sandbox Server (HTTP/gRPC)           │  │
│  │                                       │  │
│  │  - File Operations (read/write/stat)  │  │
│  │  - Shell Execution (exec/detached)    │  │
│  │  - Directory Operations (readdir/mkdir)│  │
│  │  - Workspace Management               │  │
│  │  - Port Exposure / Domain Mapping     │  │
│  │                                       │  │
│  │  系统工具: git, python, ripgrep, etc. │  │
│  │  挂载: /workspace, /sessions, /public │  │
│  └───────────────────────────────────────┘
└─────────────────────────────────────────────┘
              ▲
              │ HTTP/gRPC (internal cluster)
              │
┌─────────────┴──────────────────────────────┐
│           Agent Process (独立)              │
│                                            │
│  ┌───────────────────────────────────────┐ │
│  │  Agent Supervisor                     │ │
│  │                                       │ │
│  │  - Redis I/O (input/output)           │ │
│  │  - Session Management (fork/restore)  │ │
│  │  - Message Persistence to API         │ │
│  │  - Event Streaming to Redis           │ │
│  │                                       │ │
│  │  ┌─────────────────────────────────┐  │ │
│  │  │  Agent Engine (可替换)          │  │ │
│  │  │  - Tool definitions (抽象)      │  │ │
│  │  │  - LLM call loop                │  │ │
│  │  │  - Context management           │  │ │
│  │  │  - Subagents                    │  │ │
│  │  └─────────────────────────────────┘  │ │
│  └───────────────────────────────────────┘ │
│                                            │
│  通过 Sandbox Client 连接 Pod 内服务        │
└────────────────────────────────────────────┘
```

### 2.2 分离后的职责划分

| 组件 | 职责 | 运行位置 |
|------|------|----------|
| **Sandbox Server** | 文件系统操作、Shell 执行、端口暴露、目录管理 | K8s Pod 内 |
| **Agent Supervisor** | Redis I/O、Session 管理、消息持久化、事件流 | 独立进程（可同 Pod 或独立 Pod） |
| **Agent Engine** | LLM 调用、Tool 编排、Context 管理 | 由 Supervisor 加载，可替换 |

---

## 3. 详细设计方案

### 3.1 Sandbox Interface 定义

```typescript
// packages/sandbox/src/interface.ts

/**
 * Sandbox 抽象接口 —— 容器提供的标准操作工具
 */
export interface Sandbox {
  readonly type: 'local' | 'remote' | 'cloud';
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;

  // ── 文件操作 ──
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>;
  stat(path: string): Promise<SandboxStats>;
  access(path: string): Promise<void>;

  // ── 目录操作 ──
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;

  // ── Shell 执行 ──
  exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult>;

  execDetached?(command: string, cwd: string): Promise<{ commandId: string }>;

  // ── 网络/端口 ──
  domain?(port: number): string;

  // ── 生命周期 ──
  stop?(): Promise<void>;
}

export interface SandboxStats {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

export interface ExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
```

### 3.2 Sandbox Server (容器内)

容器内运行一个轻量 HTTP Server，暴露标准操作接口：

```typescript
// apps/sandbox-server/src/index.ts

import { Hono } from 'hono';
import {
  readFile, writeFile, stat, access, mkdir, readdir,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';

const app = new Hono();
const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace';

// ── 健康检查 ──
app.get('/health', (c) => c.json({ status: 'ok' }));

// ── 文件操作 ──
app.post('/fs/read', async (c) => {
  const { path, encoding = 'utf-8' } = await c.req.json();
  const absolutePath = resolveWorkspacePath(path);
  const content = await readFile(absolutePath, encoding as BufferEncoding);
  return c.json({ content });
});

app.post('/fs/write', async (c) => {
  const { path, content, encoding = 'utf-8' } = await c.req.json();
  const absolutePath = resolveWorkspacePath(path);
  await writeFile(absolutePath, content, encoding as BufferEncoding);
  return c.json({ ok: true });
});

app.post('/fs/stat', async (c) => {
  const { path } = await c.req.json();
  const absolutePath = resolveWorkspacePath(path);
  const s = await stat(absolutePath);
  return c.json({
    isDirectory: s.isDirectory(),
    isFile: s.isFile(),
    size: s.size,
    mtimeMs: s.mtimeMs,
  });
});

// ── Shell 执行 ──
app.post('/exec', async (c) => {
  const { command, cwd, timeoutMs = 120000 } = await c.req.json();
  const absoluteCwd = resolveWorkspacePath(cwd || '.');

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: absoluteCwd,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      resolve(c.json({
        success: code === 0,
        exitCode: code,
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 50000),
        truncated: stdout.length > 50000 || stderr.length > 50000,
      }));
    });

    child.on('error', (err) => {
      resolve(c.json({
        success: false,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        truncated: false,
      }));
    });
  });
});

// ── 路径安全校验 ──
function resolveWorkspacePath(input: string): string {
  const resolved = path.resolve(WORKSPACE, input);
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error(`Path traversal detected: ${input}`);
  }
  return resolved;
}
```

### 3.3 Sandbox Client (Agent 侧)

Agent 侧通过 HTTP Client 连接 Sandbox Server：

```typescript
// packages/sandbox/src/remote-sandbox.ts

export class RemoteSandbox implements Sandbox {
  readonly type = 'remote' as const;
  readonly workingDirectory: string;

  constructor(
    private baseUrl: string,
    workingDirectory = '/workspace',
    public env?: Record<string, string>,
  ) {
    this.workingDirectory = workingDirectory;
  }

  async readFile(filePath: string, encoding: 'utf-8'): Promise<string> {
    const res = await fetch(`${this.baseUrl}/fs/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    return data.content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fetch(`${this.baseUrl}/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, cwd, timeoutMs }),
        signal: options?.signal ?? controller.signal,
      });
      return res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ... 其他方法
}
```

### 3.4 Tool 抽象层

Tool 不再直接操作本地文件，而是通过 Sandbox 接口：

```typescript
// packages/agent/tools/read.ts

export function createReadTool(sandbox: Sandbox) {
  return {
    name: 'read',
    description: 'Read a file from the workspace',
    parameters: z.object({
      path: z.string().describe('Workspace-relative file path'),
      offset: z.number().optional().describe('Start line (1-indexed)'),
      limit: z.number().optional().describe('Max lines to read'),
    }),
    execute: async ({ path, offset = 1, limit = 2000 }) => {
      const content = await sandbox.readFile(path, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(1, offset) - 1;
      const end = Math.min(lines.length, start + limit);
      const selected = lines.slice(start, end);

      return {
        path,
        totalLines: lines.length,
        content: selected.map((line, i) => `${start + i + 1}: ${line}`).join('\n'),
      };
    },
  };
}

export function createBashTool(sandbox: Sandbox) {
  return {
    name: 'bash',
    description: 'Execute a bash command in the workspace',
    parameters: z.object({
      command: z.string().describe('Bash command to execute'),
      cwd: z.string().optional().describe('Working directory'),
    }),
    execute: async ({ command, cwd }) => {
      const result = await sandbox.exec(command, cwd || sandbox.workingDirectory, 120000);
      return {
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}
```

### 3.5 部署架构选项

#### Option A: 同 Pod 双容器（推荐首期）

```yaml
spec:
  containers:
    # 容器 1: Sandbox Server —— 提供标准操作工具
    - name: sandbox
      image: cohub-sandbox-server:latest
      ports:
        - containerPort: 3000
      volumeMounts:
        - name: workspace-storage
          mountPath: /workspace
        - name: sessions-storage
          mountPath: /sessions

    # 容器 2: Agent Supervisor —— Agent 逻辑
    - name: agent
      image: cohub-agent:latest
      env:
        - name: SANDBOX_SERVER_URL
          value: "http://localhost:3000"
      # 不再需要系统工具，依赖 sandbox 容器
```

**优点**：
- 最小改动，共享 PVC 和 network namespace
- Agent 通过 `localhost` 访问 Sandbox Server
- 两个容器独立构建、独立更新

#### Option B: 独立 Pod（适合大规模）

```
┌─────────────────────┐    ┌─────────────────────┐
│  Agent Pod          │    │  Sandbox Pod         │
│  (cohub-agent)      │───▶│  (cohub-sandbox)     │
│                     │    │                      │
│  - Supervisor       │    │  - Sandbox Server    │
│  - Redis I/O        │    │  - System Tools      │
│  - Session Mgmt     │    │  - Workspace Mount   │
└─────────────────────┘    └─────────────────────┘
```

**优点**：
- 完全独立的生命周期
- Agent 可以跨多个 Sandbox 工作
- Sandbox 可以池化复用

### 3.6 Agent 引擎可替换

分离后，Agent 引擎成为可插拔的模块：

```typescript
// packages/agent/engines/pi-engine.ts
export function createPiEngine(config: PiEngineConfig): AgentEngine {
  // 当前使用 @mariozechner/pi-coding-agent
  return {
    prompt: (text, options) => piSession.prompt(text, options),
    steer: (text, images) => piSession.steer(text, images),
    abort: () => piSession.abort(),
    dispose: () => piSession.dispose(),
    isStreaming: () => piSession.isStreaming,
    state: { model: piSession.state.model },
    subscribe: (handler) => piSession.subscribe(handler),
  };
}

// packages/agent/engines/openai-engine.ts (未来可扩展)
export function createOpenAIEngine(config: OpenAIConfig): AgentEngine {
  // 使用 OpenAI Responses API 或 Assistants API
  return { ... };
}

// packages/agent/engines/anthropic-engine.ts (未来可扩展)
export function createAnthropicEngine(config: AnthropicConfig): AgentEngine {
  // 使用 Claude Computer Use / MCP
  return { ... };
}
```

Supervisor 通过统一的 `AgentEngine` 接口与底层引擎解耦：

```typescript
interface AgentEngine {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string, images?: ImageData[]): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  isStreaming: boolean;
  subscribe(handler: EventHandler): void;
}
```

---

## 4. 迁移路径

### Phase 1: 定义 Sandbox Interface + 本地实现（1-2 周）

| 任务 | 产出 |
|------|------|
| 创建 `packages/sandbox` | `Sandbox` 接口定义 |
| 实现 `LocalSandbox` | 直接调用 fs/child_process，等价当前行为 |
| 抽象 Tool 层 | Tools 通过 Sandbox 接口操作，不再直接调用 fs |
| 更新 `apps/agent` | 使用新 Tool 层，传入 LocalSandbox 实例 |

**此阶段行为等价**，为后续分离做准备。

### Phase 2: Sandbox Server 实现（1-2 周）

| 任务 | 产出 |
|------|------|
| 创建 `apps/sandbox-server` | HTTP Server 实现 |
| 实现 Sandbox Dockerfile | 轻量容器镜像 |
| 实现 `RemoteSandbox` | HTTP Client 实现 |
| 双容器 Pod 模板 | 更新 K8s 模板 |

### Phase 3: 切换部署 + 验证（1 周）

| 任务 | 产出 |
|------|------|
| 更新 `launchRuntimeSandbox` | 部署双容器 Pod |
| 灰度发布 | 选择少量 runtime 验证 |
| 全量切换 | 所有新 runtime 使用新架构 |

### Phase 4: Agent 引擎抽象（可选，后续）

| 任务 | 产出 |
|------|------|
| 定义 `AgentEngine` 接口 | 引擎抽象层 |
| 封装 Pi Engine | 当前 Pi 实现 |
| 评估替换其他引擎 | 验证可替换性 |

---

## 5. 对比总结

| 维度 | 当前架构 | 目标架构 |
|------|----------|----------|
| **Agent 与执行环境** | 紧耦合在同一容器 | 通过接口分离 |
| **Tool 实现** | 直接操作本地 fs/shell | 通过 Sandbox 接口 |
| **Agent 引擎** | 锁定 Pi Coding Agent | 可替换 (AgentEngine 接口) |
| **容器镜像** | 单一臃肿镜像 | Sandbox 轻量 + Agent 精简 |
| **安全边界** | 无明确边界 | Sandbox 提供隔离层 |
| **后端扩展** | 不支持 | 支持 Vercel/Cloud/Local 多后端 |
| **更新影响** | 需重建整个 Pod | Sandbox/Agent 可独立更新 |
| **测试** | 需完整容器环境 | Tool 层可独立单元测试 |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| HTTP 调用增加延迟 | 工具执行延迟增加 | 同 Pod 内 localhost 通信，<1ms 额外开销 |
| 迁移期行为不一致 | 功能回归 | Phase 1 保证等价行为 + 完整测试覆盖 |
| Sandbox Server 单点 | Pod 内服务不可用 | 健康检查 + 自动重启 |
| 路径穿越攻击 | 安全问题 | Sandbox Server 严格路径校验 |

---

## 7. 文件结构变更（预期）

```
packages/
  sandbox/
    src/
      interface.ts        # Sandbox 接口定义
      local-sandbox.ts    # 本地实现（Phase 1）
      remote-sandbox.ts   # HTTP 客户端（Phase 2）
      index.ts
  agent/
    src/
      tools/              # 抽象 Tool 定义
        read.ts
        write.ts
        bash.ts
        ...
      engines/            # 引擎抽象（Phase 4）
        pi-engine.ts
        types.ts
      supervisor/         # 从 apps/agent 提取
        index.ts
        session-manager.ts
        persistence.ts
apps/
  agent/                  # 精简为 Supervisor 入口
    src/
      index.ts            # 启动 Supervisor
      env.ts
      redis.ts
  sandbox-server/         # 新增（Phase 2）
    src/
      index.ts            # HTTP Server
      handlers/
        fs.ts
        exec.ts
    Dockerfile
```
