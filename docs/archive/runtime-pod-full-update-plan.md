# Runtime Pod 全量更新方案

## 1. 背景与问题

### 当前架构

- 每个 Runtime 对应一个独立 K8s Pod（`sandbox-${RUNTIME_ID}`），运行在 `cohub-sessions` namespace
- Pod 不是由 Deployment 管理，而是由 API 侧通过 `k8s.createNamespacedPod()` 动态创建
- Pod 使用 `restartPolicy: Never`，是一次性生命周期

### 当前更新机制的局限

| 更新内容 | 当前行为 | 影响范围 |
|---------|---------|---------|
| 升级 agent 镜像（修改 `SANDBOX_RUNTIME_IMAGE`） | API 重启后生效 | **仅影响新建的 Pod**，已有 Pod 不变 |
| 更新 global config（修改 configs.git） | Pod 启动时 clone 生效 | **仅影响新建的 Pod**，已有 Pod 不变 |

### 核心问题

线上可能同时存在数十上百个正在运行的 runtime pod，当发布新版 agent 镜像或更新 global config 时，**已有 Pod 无法自动获得更新**，只能等用户手动 hibernate/wake 或 API 触发重建。

---

## 2. 设计目标

1. **全量覆盖**：能一次性选中所有 running 状态的 runtime pod 进行更新
2. **滚动更新**：避免同时重建所有 Pod 导致服务雪崩，支持并发度控制
3. **安全回滚**：更新过程中如果出问题，能快速回滚
4. **最小中断**：正在执行中的 Agent task 应尽量完成或优雅中断
5. **幂等可重试**：操作失败可安全重试，不会导致重复创建或状态不一致

---

## 3. 方案设计

### 3.1 总体思路

采用 **"逐 Pod 替换 + API 侧编排"** 的方案：

```
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│  触发入口    │───▶│  API 编排器  │───▶│  逐 Pod 滚动替换  │
│ (CLI/脚本)  │    │  (admin API) │    │  (并发度可控)     │
└─────────────┘    └──────────────┘    └──────────────────┘
                                                │
                    ┌───────────────────────────┘
                    ▼
          ┌─────────────────────┐
          │  单 Pod 替换流程     │
          │  1. 标记即将重建     │
          │  2. 等待活跃任务完成  │
          │  3. 删除旧 Pod       │
          │  4. 等待旧 Pod 清理   │
          │  5. 创建新 Pod       │
          │  6. 等待新 Pod ready │
          └─────────────────────┘
```

### 3.2 触发入口设计

**方案 A：Admin CLI 脚本（推荐首期实现）**

在 `deploy/api/prod/` 下新增 `rollout-agent.sh` 脚本：

```bash
# 用法
./rollout-agent.sh                    # 使用 values.yaml 中的 SANDBOX_RUNTIME_IMAGE
./rollout-agent.sh --image v20260415  # 指定镜像版本
./rollout-agent.sh --concurrency 3    # 指定并发度（默认 2）
./rollout-agent.sh --dry-run          # 预演，不实际执行
```

**方案 B：Admin API 端点（后续扩展）**

```
POST /api/admin/runtimes/rollout
Body: {
  "image": "git.talesofai.com/talesofai/cohub-agent:v20260415",  // 可选，默认取当前配置
  "concurrency": 3,
  "force": false
}
```

> 首期推荐 CLI 方案，实现简单、可控性强。后续有需要再加 API 端点。

### 3.3 单 Pod 替换流程

```
Step 1: 查询所有 running 状态的 runtime
        └─ SELECT * FROM runtimes WHERE status = 'running'

Step 2: 对每个 runtime，执行以下流程：
        │
        ├─ 2.1 [可选] 发送 graceful shutdown 信号给 Pod 内的 agent
        │       └─ POST /api/internal/runtimes/:id/shutdown
        │       └─ 等待最多 30s 让当前 turn 完成
        │
        ├─ 2.2 更新 DB: runtime status = 'rolling_update'
        │
        ├─ 2.3 删除旧 Pod: k8s.deleteNamespacedPod("sandbox-${runtimeId}")
        │
        ├─ 2.4 等待旧 Pod 完全消失（deletionTimestamp 清除 / 404）
        │       └─ 超时 60s，超时则强制继续
        │
        ├─ 2.5 创建新 Pod: 复用 launchRuntimeSandbox / provisionRuntimeInBackground 逻辑
        │       └─ 使用最新的 SANDBOX_RUNTIME_IMAGE 配置
        │       └─ 新 Pod 启动时自动 clone 最新的 global config
        │
        ├─ 2.6 等待新 Pod ready
        │       └─ 等待 runtime status = 'running'（由 agent 上报）
        │       └─ 超时 120s
        │
        ├─ 2.7 更新 DB: runtime status = 'running'
        │
        └─ 2.8 记录更新结果（成功/失败/超时）

Step 3: 输出汇总报告
```

### 3.4 并发控制

滚动更新的并发度至关重要：

- **默认并发度 2**：同时最多 2 个 Pod 在替换中
- 可配置范围 1~5，避免过大影响线上服务
- 使用信号量或队列控制并行度

```bash
# 伪代码
concurrency=${CONCURRENCY:-2}
semaphore_init $concurrency

for runtime in ${RUNTIMES}; do
  semaphore_wait
  (
    replace_single_pod "$runtime" &
    semaphore_signal
  ) &
done

wait  # 等待所有完成
```

### 3.5 Global Config 更新的特殊处理

Global config 存储在 `https://gitea.cohub.run/global/configs.git`，Agent 在启动时 clone 到 HOME 目录。

**关键行为**：
- 新 Pod 启动时自动拉取最新 global config
- **不需要**在运行时动态推送 config 到已有 Pod

因此，**Pod 替换本身就已经完成了 global config 的更新**。

### 3.6 镜像版本管理

```
SANDBOX_RUNTIME_IMAGE 来源（优先级从高到低）：
1. CLI --image 参数显式指定
2. API 容器环境变量 SANDBOX_RUNTIME_IMAGE
3. API config.ts 中的默认值
```

CLI 脚本在更新前应先读取 API 的 ConfigMap 获取当前配置：

```bash
CURRENT_IMAGE=$(kubectl get configmap cohub-api-config -n cohub \
  -o jsonpath='{.data.SANDBOX_RUNTIME_IMAGE}')
echo "当前 agent 镜像: ${CURRENT_IMAGE}"
```

---

## 4. 需要新增的代码改动

### 4.1 API 侧（apps/api）

#### 4.1.1 新增 Admin API 端点（可选，CLI 可跳过）

```
POST /api/admin/runtimes/rollout  — 触发全量滚动更新
GET  /api/admin/runtimes/rollout/:id  — 查看更新任务状态
```

#### 4.1.2 新增 graceful shutdown 端点

```
POST /api/internal/runtimes/:id/shutdown
```

- Agent 侧收到信号后，等待当前 turn 完成再退出
- 设置一个硬超时（如 30s），超时后直接终止

#### 4.1.3 新增 replaceRuntimeSandbox 函数

```typescript
export const replaceRuntimeSandbox = async (input: {
  runtimeId: string;
  userUuid: string;
  timeoutMs?: number;
}) => {
  // 1. 标记状态
  await updateRuntimeStatus(input.runtimeId, 'rolling_update');
  
  // 2. 删除旧 Pod（带重试和超时）
  await deletePodAndWait(input.runtimeId);
  
  // 3. 创建新 Pod
  await launchRuntimeSandbox(input);
  
  // 4. 等待就绪
  const ready = await waitForRuntimeRunning(input.runtimeId, 120000);
  if (!ready) {
    await updateRuntimeStatus(input.runtimeId, 'error');
    throw new Error('Runtime failed to become ready after replacement');
  }
  
  await updateRuntimeStatus(input.runtimeId, 'running');
};
```

### 4.2 Agent 侧（apps/agent）

#### 4.2.1 新增 graceful shutdown 处理

```typescript
// 监听 SIGTERM 或 shutdown 信号
process.on('SIGTERM', async () => {
  console.log('[Agent] Received shutdown signal, finishing current turn...');
  await waitForCurrentTurnComplete(30000); // 最多等 30s
  await setRuntimeStatus('hibernated');
  process.exit(0);
});
```

### 4.3 部署脚本（deploy/api/prod）

#### 4.3.1 新增 rollout-agent.sh

完整的滚动更新脚本，包含：
- 前置检查（连接、权限、镜像可达性）
- 获取所有 running runtime
- 并发控制滚动替换
- 进度报告与汇总
- 失败回滚选项

#### 4.3.2 更新 deploy.sh

在 `deploy.sh` 中支持 `--rollout` 参数，部署 API 后自动触发 Pod 滚动更新：

```bash
./deploy.sh --rollout          # 部署后自动滚动更新所有 runtime pod
./deploy.sh --rollout --wait   # 部署后滚动更新，等待全部完成
```

---

## 5. 操作流程

### 5.1 日常更新流程

```bash
# 1. 构建并发布新镜像（CI/CD 已完成）
# 2. 更新 API ConfigMap 中的镜像版本
kubectl edit configmap cohub-api-config -n cohub
#    修改 SANDBOX_RUNTIME_IMAGE 为新版本

# 3. 重启 API 使配置生效
kubectl rollout restart deployment/cohub-api -n cohub

# 4. 执行滚动更新
cd deploy/api/prod
./rollout-agent.sh --concurrency 3
```

### 5.2 一键更新流程（deploy.sh 集成后）

```bash
cd deploy/api/prod
./deploy.sh --rollout
```

### 5.3 仅更新 global config（不升级镜像）

```bash
cd deploy/api/prod
./rollout-agent.sh --keep-image   # 保持当前镜像，仅重建 Pod 获取新 config
```

---

## 6. 回滚方案

### 6.1 镜像回滚

```bash
# 回滚到上一个镜像版本
./rollout-agent.sh --image git.talesofai.com/talesofai/cohub-agent:v20260325
```

### 6.2 部分回滚

如果更新到一半发现问题，脚本应支持：

```bash
./rollout-agent.sh --resume --image <旧版本>
# 从上次中断的位置继续，使用旧版本镜像
```

> 实现方式：在 Redis 或临时文件中记录更新进度（已更新/待更新/失败的 runtime ID 列表）。

---

## 7. 安全与风险控制

| 风险 | 缓解措施 |
|------|---------|
| 全部 Pod 同时重建导致服务不可用 | 并发度控制（默认 2） |
| 新镜像有 bug | 先灰度 1~2 个 Pod 验证，再全量 |
| Pod 删除后新 Pod 启动失败 | 单 Pod 超时检测 + 状态回滚 |
| 正在进行的 Agent 任务中断 | graceful shutdown 机制，等待当前 turn 完成 |
| 滚动更新中途被中断 | 记录进度，支持 resume |
| Global config 有误 | Pod 保留旧 config 直到新 Pod 启动成功 |

### 推荐发布策略

```
第一阶段：dry-run 验证
  ./rollout-agent.sh --dry-run
  → 确认目标列表、镜像版本

第二阶段：灰度验证（选 1-2 个不重要的 runtime）
  ./rollout-agent.sh --target runtime-id-1,runtime-id-2
  → 验证新 Pod 启动正常、agent 工作正常

第三阶段：全量滚动更新
  ./rollout-agent.sh --concurrency 2
  → 自动逐个替换所有 running runtime
```

---

## 8. 文件清单

需要新增/修改的文件：

| 文件 | 操作 | 说明 |
|------|------|------|
| `deploy/api/prod/rollout-agent.sh` | **新增** | 滚动更新 CLI 脚本 |
| `deploy/api/prod/README.md` | 修改 | 补充使用说明 |
| `apps/api/src/runtime-sessions.ts` | 修改 | 新增 `replaceRuntimeSandbox` 函数 |
| `apps/api/src/index.ts` | 修改 | 注册 admin/shutdown 端点（可选） |
| `apps/agent/src/index.ts` | 修改 | 新增 SIGTERM graceful shutdown |

---

## 9. 实施建议

**分阶段实施**：

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| P0 | `rollout-agent.sh` 脚本 + API `replaceRuntimeSandbox` 函数 | 必做 |
| P1 | Agent graceful shutdown 处理 | 推荐 |
| P2 | Admin API 端点 + 进度查询 | 可选 |
| P3 | `deploy.sh --rollout` 集成 | 可选 |
| P4 | 断点续传 / resume 支持 | 可选 |

首期只实现 P0，就能满足"全量更新线上 runtime pod"的核心需求。
