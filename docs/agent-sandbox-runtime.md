# Agent / Sandbox 运行说明

本文档描述当前长期方案下的运行方式、环境变量，以及本地联调方式。

## 当前架构

- `apps/agent`
  - 控制面
  - 运行 `pi-coding-agent`
  - 管理 session / Redis / persistence
  - 作为 WebSocket 客户端主动连接 sandbox
  - 将 tools 调用通过 WebSocket RPC 转发给 sandbox
- `apps/sandbox`
  - 执行面
  - 提供 WebSocket server 等待 agent 连接
  - 执行通用 sandbox filesystem / process primitive

## Local sandbox (dial-out) 模式

除云端 listen 模式外，sandbox 二进制支持 `--local` 拨出模式，让用户本机文件夹成为某个 space 的 sandbox：

- `apps/sandbox --local --space <id> --root <dir> --relay wss://gateway/sandbox/relay`
  - 复用同一套 dispatcher / process / filewatch / ws session 代码
  - **路径围栏**：fs RPC（read/write/stat/ls/find/grep）与 process cwd 强制限制在 `--root` 内（realpath + symlink 防逃逸）
  - **进程执行不做 OS 级隔离**：`bash` / argv 以当前用户身份运行，可访问 `--root` 之外的宿主机资源。这与"在本机运行 AI coding agent"的信任模型一致，属刻意设计；`sandbox up` 启动前有显式知情同意提示。若需强隔离，请在容器 / VM 内运行 runner
  - relay data channel 目前仅以一次性随机 channelId（经已鉴权的 control 通道下发、15s 过期、单次配对）绑定；后续可加 per-channel HMAC
  - 通过 `COHUB_RELAY_TOKEN`（用户 access token）向 gateway 鉴权
- `apps/gateway` 提供 relay：
  - `/sandbox/relay`（control，本机 runner 接入，鉴权 `sandbox.manage`）
  - `/sandbox/relay/data?channel=<id>`（本机按需回拨的数据通道）
  - `/internal/sandbox-relay/:spaceId`（集群内 agent/worker 接入，`x-worker-secret` 鉴权）
  - control 建立后由 gateway 作为唯一状态上报方：ready + `wsEndpoint`；断开 → stopped(disconnected)
  - 数据通道逐帧透明 pipe，gateway 不解析 RPC
- `space_sandboxes.provider = "local"` 时，controller 短路 provision / idle-destroy / recover
- CLI：`cohub sandbox up <dir>` 建/绑 space、拉起 runner、输出 web 链接

### 二进制分发

`cohub-sandboxd` 与云端 sandbox 是同一份代码，仅以 `--local` 拨出运行。CI（`.github/workflows/sandbox-binaries-build.yml`）在打 `v*` tag 时交叉编译常见平台：

- `linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`
- 每平台产出 `cohub-sandboxd_<version>_<os>_<arch>.tar.gz` + `.sha256`，附带聚合 `SHA256SUMS.txt`
- 版本经 `-ldflags -X main.buildVersion=<tag>` 注入；容器内仍以 `IMAGE_VERSION` 环境变量优先
- Windows 暂不支持（进程组管理依赖 Unix syscall，待后续补平台适配）
- 产物同时：附加到 GitHub Release（私有 repo，仅内部可下）、上传公共 CDN `https://public.cohub.run/sandboxd/<version>/`（CLI 下载源）

### 托管下载（CLI）

CLI 首次 `cohub sandbox up` 时按当前 `os/arch` 从公共 CDN 拉取对应单个平台二进制，校验 `.sha256` 后缓存到 `~/.cache/cohub/sandboxd/<version>/`，后续命中缓存：

- 版本由 CLI 内 `SANDBOXD_VERSION` 常量锁定（独立于 CLI 包版本；协议版本 `"1"` 保证向后兼容），随 runner 演进手动 bump
- `COHUB_SANDBOXD_BIN` 覆盖二进制路径（本地 `go build` / 离线 / 自建）
- `COHUB_SANDBOXD_CDN_BASE_URL` 覆盖下载源（staging / 自托管）
- 并发 `up` 用 mkdir 原子锁避免重复下载；checksum 不匹配直接拒绝

## 当前 transport 模式

当前系统只保留一种模式：

- `apps/sandbox` 提供 WebSocket server（默认监听 `0.0.0.0:8788`）
- `apps/agent` 作为客户端主动连接 sandbox
- sandbox 建连后立即发送首帧 `sandbox.heartbeat`，携带 capabilities / filesystem / metadata 快照
- 所有 tools 都通过 WebSocket RPC 转发给 sandbox

## 当前 sandbox filesystem 语义

- `/workspace`
  - 项目工作目录
  - 可读写
  - 默认 `cwd`
- `/configs/platform/.agents`
  - 平台技能与引用资源目录
  - 只读
- 其他 sandbox 本地路径
  - 如 `/tmp`
  - 可按真实机器语义访问
- 首帧 heartbeat 中返回的 `filesystem.roots`
  - 仅用于说明已知挂载与推荐目录
  - 不是访问白名单

RPC 中的 `path` / `cwd` 语义与 pi tools 保持一致：

- 支持相对路径与绝对路径
- 相对路径相对当前 `cwd` 解析
- 未显式提供 `cwd` 时，默认使用 `/workspace`
- sandbox 不做白名单 roots 限制，按真实机器语义处理路径
- 仅对 `/configs/platform/.agents` 施加只读保护

## 关键环境变量

### Agent

- `LOCAL_SANDBOX_SPACE_ID` — 本地调试时指定 sandbox 的 space ID
- `LOCAL_SANDBOX_WS_URL` — 本地调试时 sandbox 的 WebSocket 地址（如 `ws://127.0.0.1:8788/sandbox`）
- `SPACE_ID`
- `REDIS_URL`
- `SPACE_DIR`
- `SESSIONS_DIR`
- `ENV`
- `WORKER_SECRET`

### Sandbox

- `SANDBOX_WS_HOST=0.0.0.0`
- `SANDBOX_WS_PORT=8788`
- `SPACE_ID`
- `SANDBOX_ID`
- `WORKSPACE_DIR`
- `PLATFORM_AGENTS_DIR=/configs/platform/.agents`
- `HEARTBEAT_INTERVAL_SECS`
- `IMAGE_VERSION`

## 本地联调

### 启动 sandbox（服务端）

```bash
cd apps/sandbox
SANDBOX_WS_HOST=0.0.0.0 \
SANDBOX_WS_PORT=8788 \
SPACE_ID=00000000-0000-0000-0000-000000000001 \
SANDBOX_ID=sandbox-dev \
WORKSPACE_DIR=/tmp/cohub-sandbox-workspace \
PLATFORM_AGENTS_DIR=/configs/platform/.agents \
go run .
```

默认监听：`ws://0.0.0.0:8788/sandbox`

### 启动 agent（客户端）

```bash
cd apps/agent
LOCAL_SANDBOX_SPACE_ID=00000000-0000-0000-0000-000000000001 \
LOCAL_SANDBOX_WS_URL=ws://127.0.0.1:8788/sandbox \
pnpm dev
```

## 当前 remote tools 覆盖面

- `read` -> `fs.read`
- `write` -> `fs.write`
- `edit` -> agent 侧 diff + remote read/write
- `bash` -> `process.start` / `process.abort`
- `ls` -> `fs.stat` + `fs.ls`
- `find` -> `fs.stat` + `fs.find`
- `grep` -> `fs.grep`

## 当前状态语义

1. API 先上报 `provisioning`
2. 创建 sandbox Pod，sandbox 启动 WS server
3. agent 作为客户端主动连接 sandbox
4. sandbox 发送首帧 `sandbox.heartbeat`，同时携带能力与文件系统快照
5. 后续 heartbeat 持续上报 sandbox runtime 状态；workspace 内容初始化由 worker 独立完成
6. sandbox ready 与 workspace bootstrap ready 分别建模，不再耦合

## 当前限制 / 后续事项

- 目前 active sandbox connection 还是单连接模型
- API / deployment 层仍需补 agent Deployment / Service 的最终定义
- `space_sandboxes` 的 status / heartbeat / endpoint 还需要进一步整理
