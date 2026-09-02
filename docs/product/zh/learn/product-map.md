---
title: 产品地图
description: Cohub UI 的简明地图 — 侧栏、Chat、预览与设置。
---

这页对齐产品界面，方便后续文档共用同一套布局语言。

## 应用壳

登录后，Cohub 是一个工作区壳：

- **左侧栏** — Space 切换、Chats、Saves、Apps、任务、labels、账户入口
- **主面板** — 通常是 Chat，有时是设置或管理页
- **预览 / 文件区** — 在对话旁打开文件、目录和端口
- **命令面板** — `⌘K` / `Ctrl K` 全局搜索与导航
- **帮助** — `?` 查看快捷键

移动端上，这些区域会变成抽屉和堆叠页面，而不是桌面端多栏布局。

## 侧栏

侧栏是 Space 的导航骨架。

常见分组：

| 区域 | 内容 |
| --- | --- |
| Space 头部 | 当前 Space、切换器、设置入口 |
| Chats | 对话列表，常按 labels 组织 |
| Saves | checkpoint 历史 |
| Apps | 该 Space 已发布的表面 |
| Tasks / schedules | 异步运行与定时 prompt |
| Labels | 自定义与系统组织 |

如果「东西不见了」，先检查 labels 和折叠分区，再判断是否被删除。

## Chat 表面

Chat 页面大致由这些部分组成：

1. **Transcript** — turns、工具调用、流式输出
2. **Composer** — 输入、模型选择、附件、slash 命令
3. **Turn 工具** — 导航、fork、后续控制、分享 / 访问

Composer 属于 Chat，不是单独产品区。关键动作包括：

- 选择模型
- 发送或强制发送
- 附加文件或图片
- 使用 `/` prompts 和 `/skill:` skills
- 需要外部上下文时，用 `@space` 引用其他 Space

## 文件与预览

工作区文件属于 Space，不只存在于 Chat 记录里。

常见动作：

- 浏览并打开文件
- 编辑文本文件
- 上传本地文件
- 预览 HTML 等受支持内容
- 打开公开 Sandbox 端口查看实时应用

Chat 和预览应一起用：一边对话，一边检查产物。

## Space 设置

Space settings 管的是 Space 的长期配置：

- 资料、slug、头像
- 成员与角色
- 登录用户 / 匿名用户访问策略
- Channels
- Mods
- Sandbox 规格 / 休眠行为
- 环境变量
- 启用时的 commerce

设置用于搭建；日常创作仍在 Chat + Files。

## 全局表面

单个 Space 之外还有：

| 表面 | 作用 |
| --- | --- |
| Sessions inbox | 跨 Space 的最近 Chats |
| Trending | 发现公开动态 |
| 公开 App 页 | `/:username/:spaceSlug/w/:appSlug` |
| 账户设置 | 资料、外观、账单、推荐、Channel 默认值 |

## 心智模型

```text
Account
  └── Spaces
        ├── Chats + Composer
        ├── Files + Sandbox + Preview
        ├── Saves
        ├── Apps
        ├── Tasks / Scheduled prompts
        ├── Labels
        └── Settings（成员、访问、channels、mods、env）
```

迷路时先问：**我在哪个 Space，正在看哪个对象？**
