# Cohub Gateway 部署

Gateway 负责维护与第三方 IM 平台（Discord、Telegram、Feishu 等）的长连接，同时提供 HTTP API 供 Cohub 后端调用。

## 架构特点

- 使用 **StatefulSet** 部署，保证 Pod 名字固定（如 `cohub-gateway-dev-0`）
- 通过 **Redis Streams** 与 API 通信
- 提供 **HTTP API**（默认 8788 端口）供后端服务调用
- 支持多副本水平扩展，API 自动分配 Channel 到各个节点
- 通过 **HTTPRoute** 暴露外部访问（可选）

## 目录结构

```
gateway/
├── manifests/           # K8s 资源模板
│   ├── configmap.tmpl.yaml
│   ├── statefulset.tmpl.yaml
│   ├── service.tmpl.yaml
│   └── httproute.tmpl.yaml
├── dev/                 # Dev 环境配置
│   ├── values.yaml
│   ├── secrets.yaml
│   └── deploy.sh
└── prod/                # Prod 环境配置
    ├── values.yaml
    ├── secrets.yaml
    └── deploy.sh
```

## 部署步骤

### 1. 构建并推送镜像

```bash
cd apps/gateway
docker build -t git.talesofai.com/talesofai/cohub-gateway:latest .
docker push git.talesofai.com/talesofai/cohub-gateway:latest
```

### 2. 配置 Secrets

复制模板并填入真实值：

```bash
cd deploy/gateway/dev  # 或 prod
cp secrets.template.yaml secrets.yaml
# 编辑 secrets.yaml
```

### 3. 部署

```bash
cd deploy/gateway/dev  # 或 prod
chmod +x deploy.sh
./deploy.sh
```

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `REDIS_URL` | Redis 连接地址 |
| `API_BASE_URL` | Cohub API 基础地址，用于鉴权 |
| `POD_NAME` | K8s 自动注入的 Pod 名称 |
| `ENV` | 环境标识 (dev/prod) |
| `DEBUG_MODE` | 调试模式开关 |
| `DEBUG_DISCORD_BOT_TOKEN` | 调试用的 Discord Bot Token |

## 健康检查端点

- `/healthz` - 存活探针
- `/readyz` - 就绪探针