---
title: CLI
description: 安装 Cohub CLI，登录，并在终端运行主要 Space 工作流。
---

Cohub CLI 把同一套产品表面带到终端：Spaces、Chats、files、Saves、Works、generation 等。

包名：`@neta-art/cohub-cli`

## 安装

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## 登录

```bash
cohub auth login
cohub auth whoami
```

CLI 会存储 session 并自动刷新。

在 Sandbox 或 CI 中，可用 `COHUB_EXECUTION_TOKEN` 覆盖已存储鉴权，用于临时运行。

## 环境

默认是 production。

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## 全局 flags

| Flag | 作用 |
| --- | --- |
| `-s, --space <id>` | 指定 space-scoped 命令的目标 Space |
| `--json` | 机器可读输出 |
| `-h, --help` | 命令帮助 |

很多工作流需要 Space：

```bash
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

## 术语

| UI | CLI |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule / cron jobs |

## 常见工作流

### Spaces

```bash
cohub spaces ls --json
cohub spaces create --name "Demo" --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces files ls
```

### 向 Chat 发送 prompt

```bash
cohub -s <spaceId> spaces prompt "Fix the failing tests" --json
cohub -s <spaceId> spaces prompt --title "Planning" "Draft a launch plan" --json
cohub -s <spaceId> spaces prompt --session <sessionId> "Continue from the diff" --json
```

调度：

```bash
cohub -s <spaceId> spaces prompt --at "2026-07-20T09:00:00+08:00" "Weekly review" --json
```

### 在 Space 工作区运行命令

```bash
cohub -s <spaceId> run -- git status
```

### Files

```bash
cohub -s <spaceId> spaces files ls
cohub -s <spaceId> spaces files cat README.md
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files diff
```

### Works

```bash
cohub -s <spaceId> works publish demo --file dist/index.html
cohub -s <spaceId> works publish site --dir dist
cohub -s <spaceId> works ls --json
cohub works stats <workId|url|username/space/work>
```

Realtime rooms 使用已发布 Work 的 runtime 身份。请在 Work 内使用
`client.work.realtime`；CLI 不提供房间命令。

### 操作 Cohub 界面

在 Space 中运行的 Agent 可以在发起该对话的 Cohub 标签页里打开 Work 预览，并调用
Work 自己暴露的方法。

```bash
cohub ui preview <workId|url|cohub://works/...|username/space/work>
cohub ui preview <work> --call selection.get
cohub ui preview <work> --call board.focus --data '{"nodeId":"n1"}'
```

打开预览是幂等的：重复执行只会重新激活同一个标签页。`--call` 会等待 Work 声明就绪
后再调用方法。具体有哪些方法由 Work 作者决定，通过
`client.work.surface.handle(name, handler)` 注册。

命令只会到达发起当前工作的那个前端实例，目标从请求 provenance 推导得出。它无法作用于
其他用户，也不提供 DOM 访问或脚本执行能力。

### 本地 Sandbox

把本地目录暴露为 Space Sandbox：

```bash
cohub sandbox up ./my-project
cohub sandbox status
```

### Search 与 models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

## 输出约定

脚本或 Agent 需要串联命令时，使用 `--json`。

```bash
cohub spaces ls --json
cohub -s <spaceId> spaces sessions ls --json
```

交互使用可读输出即可；自动化优先 JSON。

## 下一步

- UI 产品闭环：[快速开始](/docs/zh/learn/quick-start)
- 程序化访问：[SDK](/docs/zh/developers/sdk)
- 发布细节：[Works](/docs/zh/create/works)
