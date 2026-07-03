# fs-api 拆分执行方案

> 基于 `docs/fs-api-split-architecture.html` 的架构方向，按选项 A 推进：system-storage 迁走，checkpoint-cache 留 api。

## 1. 目标

把 workspace FS 读写 + checkpoint FS 历史读从 `apps/api` 拆到独立的 `apps/fs-api`，实现：

- **资源隔离**：FS 的 I/O 尖刺不再与业务 API 抢 CPU / event loop
- **api 接近无状态**：卸掉 space-storage + system-storage 两个 PVC，调度自由、rollout 干净
- **独立伸缩**：fs-api 按自身流量曲线 HPA，不被业务带偏
- **URL 空间不变**：SDK / CLI / web / 移动端零改动，Traefik 边缘拆分对客户端透明

## 2. 最终架构边界

### 2.1 路由归属

| URL | 归属 | 存储 |
|-----|------|------|
| `/api/spaces/:id/fs/*`（全集：tree/file/files/file·PUT/dir/node/move/download/uploads/complete/upload） | **fs-api** | space-storage |
| `/api/spaces/:id/checkpoints/:cid/fs/*`（tree/file） | **fs-api** | system-storage（git）+ Redis 三层缓存 |
| `/api/spaces/:id/checkpoints`（POST/GET 列表） | api | db |
| `/api/spaces/:id/checkpoints/:cid`（GET 元数据，无 /fs） | api | db |
| 其余全部业务 API | api | db / Redis |

**Traefik 规则**（单条 PathRegexp 覆盖两种 fs 子路径，全 method）：

```yaml
# 规则 ① — fs 子路径 → fs-api
PathPrefix(`/api/spaces`)
&& PathRegexp(`^/api/spaces/[^/]+/(fs|checkpoints/[^/]+/fs)(/|$)`)
→ apps/fs-api :8789

# 规则 ② — fallback → api
Host(`api.cohub.run`)
→ apps/api :8787
```

正则要点：`[^/]+` 只吃 spaceId；`fs` 或 `checkpoints/[^/]+/fs` 后必须跟 `/` 或结尾。这样 `/checkpoints`（列表）、`/checkpoints/:cid`（元数据）**不会被误匹配**，自然落回 api。此边界必须写成显式路由测试用例。

### 2.2 存储归属

| PVC | api | fs-api | worker | 说明 |
|-----|:---:|:---:|:---:|------|
| space-storage (`cohub-spaces-pvc`) | ❌ 卸掉 | ✅ 读写 | ✅ 读写 | workspace 文件 |
| system-storage (`cohub-system-pvc`) | ❌ 卸掉 | ✅ 读（git cat-file） | ✅ 写（git commit） | checkpoint git 仓库 |
| checkpoint-cache (`cohub-checkpoints-pvc`) | ✅ 留 | ❌ 不挂 | ✅ 读写 | 选项 A：只 prompt-templates 读 |
| /configs (space-storage subPath) | ✅ 留 | ❌ | ✅ | platform/user prompts |

**为什么 checkpoint-cache 留 api**：api 侧只有 `prompt-templates.ts:56` 真实读 checkpoint-cache（mod prompts 物化目录）。`space-sandboxes.ts:380` 只拼 subPath 字符串塞进 sandbox pod 描述，api 不读文件。`checkpoint-fs.ts` 的 `"latest"` 解析走 db 拿 headCheckpointId 后用 `git cat-file` 读 system-storage，**不碰 checkpoint-cache**。

**prompt-templates 跨三个存储根**（platformConfigRoot + spaceStorageRoot + checkpointCacheRoot），单独迁 checkpoint-cache 解锁不了 api 无状态，留 api 最简。

### 2.3 数据库

- **schema 归属**：api 独占，migration-job 只在 api deploy 流程
- **fs-api 只读**共享表（checkpoints / spaces / work-sessions / permissions 相关），**绝不跑 migration**
- **连接池**：fs-api pool 上限开小（只读鉴权 + checkpoint 元数据），避免两 app 连接数叠加打爆 Postgres

## 3. 共享包设计（Phase 0 提取，防漂移）

### 3.1 `@cohub/core/auth` — 鉴权

工厂注入 db，两 app 权限语义一致。

```
packages/core/auth/
  src/
    middleware.ts       # createAuthMiddleware({db}) → execution + work_session 双 principal
                        #   getOptionalAuth(c): AuthUser | null  （读路径，full/filtered/denied）
                        #   useAuth(c): AuthUser                （写路径，必选）
    permissions.ts      # createPermissionChecker(db) → hasPermission(user, perm, {spaceId})
                        #   含 workViewerGrants、SpaceRole
    work-sessions.ts    # HMAC JWT 签发/验证（93 行，原样搬）
    types.ts            # AuthUser / ExecutionAuthPrincipal / WorkSessionPrincipal
  index.ts              # 导出上述全部
```

**关键**：现状有 `execution` 和 `work_session` 两种 principal，加上 `getOptionalAuth`（决定 full/filtered/denied 可见性）和 `useAuth`（写路径必选）。五种语义必须原样搬到工厂，否则 fs-api 权限模型悄悄漂移。

### 3.2 `@cohub/core/fs-cdn` — CDN key 单一来源（不动）

```
packages/core/fs-cdn/
  src/
    policy.ts           # shouldUseFsCdnCache / shouldUseFsCdnForMeta
    types.ts            # FsCdnManifest / FsCdnFileMeta / FsCdnWarmReason
    keys.ts             # buildFsCdnManifestKey / buildFsCdnObjectKey / buildFsCdnFailKey / buildFsCdnJobId
    prewarm.ts          # enqueueFsCdnWarmFile / enqueueFsCdnWarmForChanges
    constants.ts        # FS_CDN_*_TTL_SECONDS / FS_CDN_POLL_INTERVAL_MS / 超时
  index.ts
```

warm 和 manifest 的 key 必须在 fs-api、worker、api 三处一致，单一来源。

### 3.3 `@cohub/space-fs` — FS 读写全量 + checkpoint fs

工厂注入 db（checkpoint-fs 需要），redis client 注入。

```
packages/space-fs/
  src/
    space-fs.ts                 # 1342 行，读写全量（注入 spaceStorageRoot）
    space-fs-ignore.ts          # createSpaceGitignoreFilter / SpaceFsVisibility
    space-fs-cdn-cache.ts       # ensureFsCdnManifest / waitForFsCdnManifests / buildUrlFileResponse
    space-fs-cdn-queue.ts       # enqueueFsCdnWarmForMeta（薄封装，转 @cohub/core/fs-cdn）
    space-fs-cdn-prewarm.ts     # enqueueFsCdnWarmForChanges
    space-upload-storage.ts     # presigned PUT/GET（注入 turnObjectS3 config）
    sandbox-bash-queue.ts       # enqueueSandboxUploadFilesJob（BullMQ）
    space-events.ts             # dispatchSpaceFsChanged（realtime publish + CDN warm）
    checkpoint-fs.ts            # 837 行，git cat-file + Redis 三层缓存（注入 db + spaceSystemRoot）
    realtime-publish.ts         # 轻量 publishRealtimeEvent（只 redis.publish + resolveRealtimeEventRooms）
                                #   从 channels.ts 提取，不拖业务表依赖
  index.ts                      # 导出全部 + createSpaceFs({db, redis, config}) 工厂
```

**realtime 提取说明**：`dispatchRealtimeEvent` 在 `channels.ts` 里，但它本身只做 `redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, ...)` + 纯函数 `resolveRealtimeEventRooms`，**不读 db 业务表**。提取为 `realtime-publish.ts`，fs-api 不拖整个 channels.ts。

**checkpoint-fs 说明**：原架构文档未提及，本方案新增（因为 checkpoint fs 一起迁）。它依赖 db（checkpoints/spaces 表）+ git。放 `@cohub/space-fs` 内，工厂注入 db。

## 4. 分阶段执行

每个 Phase 一次发布、独立回滚。数据安全优先（AGENTS.md #1）。

### Phase 0a — 提取 `@cohub/core/auth`

**目标**：api 切到共享鉴权包，行为零差异。

**步骤**：
1. 新建 `packages/core/auth`，从 `apps/api/src/lib/middleware.ts` + `permissions.ts` + `work-sessions.ts` 提取
2. 改造成工厂模式：`createAuthMiddleware({db})` / `createPermissionChecker(db)`
3. api 改为 `import { createAuthMiddleware } from "@cohub/core/auth"`
4. 跑全量权限测试

**验收门**：
- 权限测试全过（full / filtered / denied 三种可见性）
- execution principal 和 work_session principal 两条路径都覆盖
- api 行为零差异（可用流量镜像对比响应）

**回滚**：revert import，api 回到本地 middleware.ts。

### Phase 0b — 提取 `@cohub/space-fs`

**目标**：api 切到共享 FS 包，行为零差异。

**步骤**：
1. 新建 `packages/space-fs`，搬入 space-fs.ts 等 8 个文件 + checkpoint-fs.ts
2. 改造成工厂：`createSpaceFs({db, redis, config})`
3. 提取 `realtime-publish.ts`（从 channels.ts 摘 dispatchRealtimeEvent 的轻量逻辑）
4. api 的 `fs.route.ts` + `spaces.route.ts`（checkpoint fs 路由）改为 import 共享包
5. api 本地保留 thin wrapper 或直接删掉原文件

**验收门**：
- fs 全路由回归（tree/file/files/write/dir/delete/move/download/upload）
- checkpoint fs 回归（tree/file，含 `latest` 解析）
- CDN 302 链路回归（manifest 命中/未命中/异步 warm）
- realtime `space.fs.changed` 事件正常发布

**回滚**：revert import，api 回到本地 space-fs.ts。

### Phase 1 — fs-api 起服 + 影子验证

**目标**：fs-api deployment 起来，挂 space-storage + system-storage，但 Traefik 还没切流量。

**步骤**：
1. 新建 `apps/fs-api`，薄入口：Hono + 鉴权中间件 + 挂载 `@cohub/space-fs` 路由
2. 新建 `deploy/fs-api/`（复制 api deploy 模板，改）：
   - 卸掉 checkpoint-cache、/configs volumeMount
   - 保留 space-storage + system-storage
   - 不跑 migration-job
   - 独立 config + secrets（Logto / db / Redis / OSS / spaceStorageRoot / spaceSystemRoot）
   - 独立 HTTPRoute（先不挂到 traefik-gateway，或挂 shadow host）
3. 部署 fs-api，用内部 service URL 直接打验证

**验收门**：
- fs-api 健康检查通过
- 直连 fs-api 打全路由，响应与 api 一致（diff 响应体）
- checkpoint fs 直连验证
- PVC 挂载正确（space-storage 读写、system-storage git 读）

**回滚**：缩容 fs-api 到 0，Traefik 未切流量，无影响。

### Phase 2 — Traefik 切流量 + 灰度

**目标**：边缘流量切到 fs-api，api 卸掉两个 PVC。

**步骤**：
1. 更新 Traefik HTTPRoute：加规则 ①（PathRegexp → fs-api），规则 ② fallback → api
2. 先灰度：可用 header / spaceId 子集切一部分流量到 fs-api，对比一致
3. 全量切：所有 `/api/spaces/:id/fs/*` 和 `/api/spaces/:id/checkpoints/:cid/fs/*` → fs-api
4. api deploy 更新：卸掉 space-storage + system-storage volumeMount + 对应 env
5. api 滚动更新（此时 api 不再挂这两个 PVC）

**验收门**：
- 灰度期响应一致率 100%
- 切完后 api pod 不再挂 space-storage / system-storage（`kubectl describe` 确认）
- fs-api HPA 上线（先 CPU-based，长期改 RPS / 队列深度）
- 全端回归（web PC + 移动端 + CLI + SDK）

**回滚**：Traefik HTTPRoute revert 规则 ①，流量落回 api；api 重新挂回 PVC（需保留旧 deploy 配置）。

## 5. 部署配置要点

### 5.1 fs-api deployment

```yaml
# 关键差异（相对 api）
containers:
  - volumeMounts:
      - name: space-storage          # ✅ workspace 读写
        mountPath: /space-storage
        subPath: __SPACE_STORAGE_SUBPATH__
      - name: system-storage         # ✅ checkpoint git 读
        mountPath: /system-storage
        subPath: __SPACE_SYSTEM_SUBPATH__
      # ❌ 不挂 checkpoint-cache
      # ❌ 不挂 /configs（prompt-templates 留 api）
    resources:
      # fs-api 不瘦：db + Logto + PVC + Redis + OSS presign
      # 资源画像接近 api 减去业务路由，别按瘦服务给
      requests: { cpu: "500m", memory: "256Mi" }
      limits: { cpu: "2", memory: "1Gi" }
volumes:
  - name: space-storage
    persistentVolumeClaim: { claimName: __SPACE_STORAGE_PVC__ }
  - name: system-storage
    persistentVolumeClaim: { claimName: __SPACE_SYSTEM_PVC__ }
# ❌ 不跑 migration-job
```

### 5.2 fs-api config 面

```
SPACE_STORAGE_ROOT=/space-storage
SPACE_SYSTEM_ROOT=/system-storage
ENV=prod
BULLMQ_REDIS_URL=...
LOGTO_ENDPOINT=...
# db（只读，pool 上限开小）
DATABASE_URL=...
# upload presign
TURN_OBJECT_S3_ENDPOINT / BUCKET / REGION / ACCESS_KEY_ID / SECRET_ACCESS_KEY
# CDN
PUBLIC_ASSET_CDN_BASE_URL / TURN_OBJECT_CDN_BASE_URL
# ❌ 不需要 PLATFORM_CONFIG_ROOT（prompt-templates 留 api）
# ❌ 不需要 CHECKPOINT_CACHE_ROOT
```

### 5.3 HPA

- 短期：CPU-based HPA（先有，解决「完全没有 HPA」的遗留）
- 长期：RPS / 请求队列深度（fs 是 I/O 尖刺型，CPU 滞后）

## 6. 数据安全保障

1. **每个 Phase 独立发布 + 独立回滚**，不混在一个变更里
2. **Phase 0 提取共享包**：api 切换后必须行为零差异才进下一阶段，用流量镜像 / 双写对比验证
3. **Phase 2 灰度**：先切子集流量，确认一致再全量
4. **api 旧 deploy 配置保留**：回滚时能快速重新挂回 PVC
5. **worker 不动**：save-checkpoint 写链路完全独立于 api/fs-api 在线，无风险
6. **CDN key 单一来源**：`@cohub/core/fs-cdn` 不动，worker warm 和 fs-api manifest 用的 key 必须一致
7. **db migration 只在 api**：fs-api deploy 流程去掉 run-migration，避免抢锁

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| 鉴权提取后 principal 语义漂移 | 权限判断错误，数据泄漏或拒绝 | Phase 0a 全量权限测试 + 流量镜像对比 |
| space-fs 提取后路径解析边界差异 | 文件读写异常 | Phase 0b fs 全路由回归 + realpath/ignore 边界测试 |
| Traefik PathRegexp 误匹配 checkpoint 非 fs 路由 | checkpoint 列表/元数据打到 fs-api 404 | 路由测试用例覆盖 `/checkpoints`、`/checkpoints/:cid`（不带 /fs） |
| db 连接数叠加打爆 Postgres | 鉴权失败 | fs-api pool 上限开小，监控连接数 |
| fs-api 资源配太低 | I/O 尖刺时 OOM | 按接近 api 的画像给资源，别按瘦服务 |
| system-storage RWX 写冲突（worker 写 + fs-api 读） | git 读到半写状态 | git 操作本身原子性 + Redis 三层缓存兜底；worker commit 后才更新 headCheckpointId |
| api 卸 PVC 后 prompt-templates 读 checkpoint-cache 失败 | mod prompt 加载断 | checkpoint-cache 留 api（选项 A），不迁 |

## 8. 验收清单（全量切完后）

- [ ] `/api/spaces/:id/fs/*` 全路由走 fs-api，响应一致
- [ ] `/api/spaces/:id/checkpoints/:cid/fs/*` 走 fs-api，git cat-file + Redis 缓存正常
- [ ] api pod 不挂 space-storage / system-storage（kubectl 确认）
- [ ] api 仍挂 checkpoint-cache + /configs（prompt-templates 正常）
- [ ] worker save-checkpoint 链路不受影响
- [ ] CDN warm（worker）+ CDN read（fs-api 302）链路正常
- [ ] realtime `space.fs.changed` 事件正常发布到 gateway
- [ ] web PC + 移动端 + CLI + SDK 全端回归
- [ ] fs-api HPA 上线
- [ ] Traefik 路由测试用例覆盖边界

---

## 9. 上线操作手册（完整流程）

> 当前代码状态：Phase 0 共享包已提取，api 已切 thin re-export（行为零差异），fs-api 代码+deploy+workflow 就绪。api 的 deployment.tmpl.yaml 还没改（还挂 PVC），fs.route.ts 还在 api。以下是从零到完成的可执行步骤。

### 前置条件

- [ ] 代码已 merge 到 main
- [ ] api CI 已自动部署 thin re-export 版（push main 即触发，无需手动操作）
- [ ] api 健康检查通过，fs 功能正常（因为 thin re-export 行为零差异）

### 步骤 1：创建 fs-api dev secrets

```bash
cd deploy/fs-api/dev
cp secrets.template.yaml secrets.yaml
```

编辑 `secrets.yaml`，从 api dev secrets **复制相同值**（必须一致，否则鉴权/队列会失败）：

| key | 来源 |
|-----|------|
| `DATABASE_URL` | 与 `cohub-api-dev-secrets` 相同 |
| `REDIS_URL` | 与 api dev 相同 |
| `BULLMQ_REDIS_URL` | 与 api dev 相同 |
| `APP_ENCRYPTION_KEY` | 与 api dev 相同（work-session token 验签依赖） |
| `WORKER_SECRET` | 与 api dev 相同（内部请求校验） |
| `TURN_OBJECT_S3_ACCESS_KEY_ID` | 与 api dev 相同（upload presign） |
| `TURN_OBJECT_S3_SECRET_ACCESS_KEY` | 与 api dev 相同 |

### 步骤 2：dev 创建 fs-api 资源（ROUTE_ENABLED=false，不切流量）

```bash
# merge PR 后从 main 拿 short sha
SHA=$(git rev-parse --short origin/main)
cd deploy/fs-api/dev
OVERRIDE_IMAGE_TAG=main-$SHA ./deploy.sh
```

这会创建：ConfigMap + Service + Deployment（ROUTE_ENABLED=false 不创建 HTTPRoute）。
fs-api pod 起来，挂 space-storage + system-storage PVC，但不吃线上流量。

验证：
```bash
kubectl get pods -n cohub-dev -l app.kubernetes.io/name=cohub-fs-api-dev
kubectl logs -n cohub-dev -l app.kubernetes.io/name=cohub-fs-api-dev -f
# 应看到 "@cohub/fs-api listening on :8789"
```

### 步骤 3：dev 影子验证（直连 fs-api service）

```bash
# port-forward 到 fs-api
kubectl port-forward -n cohub-dev svc/cohub-fs-api-dev 8789:8789

# 另一个终端，用一个真实的 dev space id 和有效 token 测试
curl -H "Authorization: Bearer <token>" \
  http://localhost:8789/api/spaces/<space-id>/fs/tree

curl -H "Authorization: Bearer <token>" \
  http://localhost:8789/api/spaces/<space-id>/checkpoints/latest/fs/tree
```

对比同一请求打 api dev（:8787）和 fs-api dev（:8789）的响应，应完全一致。

### 步骤 4：dev 切流量验证

```bash
# 改 ROUTE_ENABLED=true
cd deploy/fs-api/dev
sed -i 's/ROUTE_ENABLED: "false"/ROUTE_ENABLED: "true"/' values.yaml
./deploy.sh
```

这会创建 HTTPRoute，Traefik 把 `/api/spaces/:id/fs/*` 和 `/api/spaces/:id/checkpoints/:cid/fs/*` 切到 fs-api dev。

验证 dev 环境全端 fs 功能正常（web dev + CLI dev）。

### 步骤 5：创建 fs-api prod secrets

```bash
cd deploy/fs-api/prod
cp secrets.template.yaml secrets.yaml
```

编辑 `secrets.yaml`，从 api prod secrets **复制相同值**（同步骤 1 的表）。

### 步骤 6：prod 创建 fs-api 资源（ROUTE_ENABLED=false）

```bash
# prod 用 git tag 镜像，先打 tag 触发 CI 构建
# git tag v1.0.0 && git push origin v1.0.0
# 等 CI 构建完成后：
cd deploy/fs-api/prod
./deploy.sh
```

验证 prod fs-api pod 健康：
```bash
kubectl get pods -n cohub -l app.kubernetes.io/name=cohub-fs-api
kubectl logs -n cohub -l app.kubernetes.io/name=cohub-fs-api -f
```

### 步骤 7：prod 影子验证

```bash
kubectl port-forward -n cohub svc/cohub-fs-api 8789:8789
curl -H "Authorization: Bearer <prod-token>" \
  http://localhost:8789/api/spaces/<prod-space-id>/fs/tree
```

对比 prod api（:8787）和 prod fs-api（:8789）响应一致。

### 步骤 8：prod 切流量（关键步骤）

```bash
cd deploy/fs-api/prod
sed -i 's/ROUTE_ENABLED: "false"/ROUTE_ENABLED: "true"/' values.yaml
./deploy.sh
```

Traefik 立即把 prod fs 流量切到 fs-api。此时：
- ✅ fs 请求走 fs-api
- ✅ api 还挂着 PVC（但不再收到 fs 请求）
- ✅ 如果出问题，`sed -i 's/true/false/' values.yaml && ./deploy.sh` 秒回滚到 api

验证 prod 全端 fs 功能正常。观察 30 分钟。

### 步骤 9：api 卸 PVC（最后一步，确认稳定后）

这一步要改 api 的 deployment.tmpl.yaml，移除 space-storage + system-storage volumeMount。**确认 fs-api 稳定运行至少 30 分钟后再做**。

```bash
# 改 api deployment.tmpl.yaml（移除 space-storage + system-storage volumeMount + volume）
# 然后重新部署 api
cd deploy/api/prod
./deploy.sh
```

验证：
```bash
# api pod 不再挂 space-storage / system-storage
kubectl describe pod -n cohub -l app.kubernetes.io/name=cohub-api | grep -A5 Volumes
```

### 回滚预案

| 阶段 | 出问题 | 回滚方式 |
|------|--------|----------|
| 步骤 2-3（影子） | fs-api 起不来 | 缩容 fs-api 到 0，不影响线上 |
| 步骤 4/8（切流量） | fs 功能异常 | `ROUTE_ENABLED=false && ./deploy.sh`，流量秒回 api |
| 步骤 9（卸 PVC） | api 异常 | 用未改的 deployment.tmpl.yaml 重跑 api `deploy.sh` |
