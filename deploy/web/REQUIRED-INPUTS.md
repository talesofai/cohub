# Cohub Web（Cloudflare Workers）部署参数收集表

如果你希望通过 GitHub Actions（workflow_dispatch）部署到 Cloudflare Workers，请准备并填写以下信息。

## 1) 必填（GitHub Secrets）

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers Scripts 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `GITEA_NPM_TOKEN` | 安装私有 npm 包使用的 Gitea package token |

## 2) Web 构建环境变量

当前 Web 在构建时通过公开环境变量注入 API 地址和 Stripe embedded checkout 配置。

| 变量 | dev 示例值 | prod 示例值 | 说明 |
| --- | --- | --- | --- |
| `PUBLIC_API_ORIGIN` | `https://api-dev.cohub.run` | `https://api.cohub.run` | Web 调用的 API 地址 |
| `PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_51SYJ1w0hIk0rCwosusvVnsEoK7jupdIumnDI0cECxL1b8IvY9SIh9sIaKXhpslWiHeU0ZjIiGPHMpmna9xMONlJY00vL1MpLvM` | `pk_live_51SYJ1w0hIk0rCwosX4Qxw8y6agSRruF9RDYafMyM2dlcJmvn9nNsqYdJyCVE9OqnFEgLv7BdQn5Yc6TiE5jR85NC00ND4wtitx` | Stripe Embedded Checkout 使用的公开 publishable key |

> 说明：这些变量由 GitHub Actions 在构建前写入 `apps/web/.env`，无需再通过 Wrangler variables 配置。
> `PUBLIC_STRIPE_PUBLISHABLE_KEY` 在 workflow 中按 dev/prod 环境写入固定 publishable key。

## 3) GitHub Actions 手动部署

在 GitHub Actions 页面选择 `Web Deploy to Cloudflare Workers` → `Run workflow`，然后选择生产环境部署。

## 4) 本地手动部署命令

```bash
pnpm -C apps/web wrangler deploy
```
