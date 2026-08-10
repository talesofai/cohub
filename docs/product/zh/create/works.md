---
title: Works
description: 把 Space 中的文件、目录或端口发布为可分享的 Cohub Work，支持版本与权限。
---

Work 是从 Space 发布出来的可分享表面。

当某样东西应被直接打开时使用 Works：静态页、小站点、demo 应用，或可请求 Cohub 权限的运行时。

## Work 是什么

Work 属于一个 Space，并记录：

| 字段 | 含义 |
| --- | --- |
| Slug | URL 中的公开名 |
| Status | `published` 或 `disabled` |
| Target type | `file`、`directory` 或 `port` |
| Target ref | 路径或端口号 |
| Work scopes | 直接授予 Work 的权限 |
| Allowed viewer scopes | Work 可向每位访客请求的权限 |

公开 URL 形态：

```text
/:username/:spaceSlug/w/:workSlug
```

## 选择目标

| 目标 | 最适合 | 说明 |
| --- | --- | --- |
| File | 单个 HTML 文档 | 路径应以 `.html` / `.htm` 结尾 |
| Directory | 静态站点 | 通常需要 `index.html` 与相对资源 |
| Port | Sandbox 中的 live app | 进程须监听受支持的公开端口 |

选择能匹配输出的最简单目标。

## 从 UI 发布

1. 在 Space 中准备文件、目录或运行中的端口
2. 打开其预览
3. 点击 **Publish**
4. 设置 Work slug
5. 选择 Work scopes 与 allowed viewer scopes
6. 发布并打开公开 URL

Work 也会出现在 Space 侧栏的 Works 下。

## 管理 Work

在 Work 管理页你可以：

- 在 workspace 中预览 Work，与管理页并排查看
- 在新标签页打开公开页
- 编辑 slug、目标、状态与权限
- 从当前目标发布新版本
- 禁用或删除 Work
- 复制 Work id 供 CLI / SDK 使用

重要行为：

- 编辑目标只影响**下一次**版本来源
- 公开页在你 publish / 更新版本后变化
- 禁用会让 Work 从公开 by-slug 访问中消失

## 版本

Works 是所选目标的版本化快照。

这意味着你可以在 Space 中持续迭代，再在输出就绪时有意发布。把 version publish 当发布动作，而不是自动保存。

## 权限

Works 有两层权限：

1. **Work scopes** — Work 自身可做什么
2. **Allowed viewer scopes** — Work 可向访客请求什么

当 Work 在发布运行时中使用 Cohub SDK 读取上下文、prompt、生成，或访问被批准资源时，这很重要。

如果 Work 只是静态 HTML，可能几乎不需要运行时 scope。

## Work runtime 说明

`context()`、访客授权和 Work commerce API 只在 Cohub 托管的**已发布** Work runtime 中工作。

它们不会在原始静态资源 URL 或随意本地预览壳中生效。开发这些能力时，请对着已发布 Work。

## 从 CLI 发布

```bash
cohub -s <spaceId> works publish demo --file dist/index.html
cohub -s <spaceId> works publish site --dir dist
cohub -s <spaceId> works publish app --port 5173
```

常用后续：

```bash
cohub -s <spaceId> works ls --json
cohub works get <workId|url|username/space/work> --json
cohub works stats <workId|url|username/space/work>
cohub works download <workId|url|username/space/work> --output <path>
cohub works publish-version <workId>
```

`works download` 直接从 CDN 恢复新发布的文件或目录产物，并校验 checksum。带有配套资源的 HTML 文件会恢复为目录 bundle。Board 和 port Work 不支持下载。

## 实用建议

- 广泛分享 URL 前先稳定路径
- 重大发布里程碑前先 Save
- 使用清晰 slug：`pitch`、`v1`、`docs-demo`
- 只需下线时优先 disable，而不是 delete
- 对 SDK 驱动的 Works，刻意选择 scopes — 最小权限优先

## 相关

- [快速开始](/docs/zh/learn/quick-start)
- [Files 与 Sandbox](/docs/zh/workspace/files-and-sandbox)
- [SDK](/docs/zh/developers/sdk)
