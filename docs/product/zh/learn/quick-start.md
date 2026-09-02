---
title: 快速开始
description: 创建 Space，与 Agent 对话，处理文件，创建 Save，并发布 App。
---

这是 Cohub 最短、但仍有用的闭环。目标是干净地走通一遍，而不是做到完美。

## 1. 登录并打开 Cohub

打开 [cohub.live](https://cohub.live) 并登录。

如果已有 Spaces，应用会带回最近工作；否则创建新 Space。

## 2. 创建 Space

1. 用清晰名称创建 Space
2. 如需公开访问，可稍后在设置里配置 slug
3. 进入 Space，默认落在新 Chat

新 Space 已是完整工作区：文件、Sandbox、Saves、Apps 即使为空也已可用。

## 3. 开始 Chat

1. 需要时选择模型
2. 告诉 Agent 你想构建或探索什么
3. 目标尽量具体：「搭一个落地页」「检查这个仓库」「起草一个 API」

有用的首条 prompt：

```text
在这个 Space 创建一个最小静态站点，并解释文件结构。
```

```text
先审查工作区，再在改动前给出简短计划。
```

## 4. 处理文件

Agent 工作时：

- 打开文件树
- 检查生成或修改的文件
- 需要时上传参考素材
- 有 HTML 或运行端口时预览

验证进度不必离开 Chat。让对话和工作区并排进行。

## 5. 创建 Save

当 Space 到达有意义的状态时：

1. 创建 Save
2. 写一句之后能看懂的备注
3. 确认 diff 符合预期

在工作里程碑后 Save，不要每条消息都 Save。

## 6. 发布 App

如果 Space 已有可分享产物：

1. 打开 HTML 文件、站点目录或运行中的端口
2. 发布为 App
3. 选择 App slug
4. 打开公开 URL

App 目标类型：

| 目标 | 适用场景 |
| --- | --- |
| File | 单个 HTML 页面 |
| Directory | 含 `index.html` 与相对资源的静态站点 |
| Port | Sandbox 中运行的实时应用 |

## 7. 可选下一步

- 在 Space settings 邀请协作者
- 如需 Discord / Telegram / 飞书 / 微信入口，绑定 Channel
- 通过 [CLI](/zh/docs/developers/cli) 在终端走同一闭环
- 需要可复用工具时挂载 Mods 或 skills

## 完成标准

以下四项都能回答「是」：

1. 我有一个 Space
2. 我至少有一段有价值的 Chat 历史
3. 我创建了可恢复或可继续的 Save
4. 我知道输出就绪后如何发布 App

接下来可深入 [Spaces](/zh/docs/workspace/spaces)、[Chats](/zh/docs/workspace/chats) 或 [Apps](/zh/docs/create/apps)。
