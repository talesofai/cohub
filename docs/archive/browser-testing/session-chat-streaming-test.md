# Cohub Session Chat 流式体验测试手册

> 本文档记录了完整的浏览器自动化测试流程、发现的问题及后续验证步骤。
> 执行环境：`agent-browser` CLI + Chrome
> 文档目标：让任何人（包括未来的自己）能独立跑完整套测试，无需反复试错

---

## 前置准备

### 1. 环境信息

| 项目 | 值 |
|------|-----|
| Dev 环境 | `https://dev.cohub.run` |
| Auth 服务 | `https://dev-auth.neta.art` |
| API 基础路径 | `/api` |

### 2. Auth Token（备选方案 A）

如果你已经有有效的 Bearer token，可以直接注入：

```bash
# Token 有效期约 1 小时，过期后需要重新获取
# 从已登录的浏览器 localStorage 中提取：
# Key: logto:access_token:vpikk7sl9zwvefiptowtn
```

**Token 过期检查**：
```bash
agent-browser open "https://dev.cohub.run"
agent-browser wait --load networkidle
agent-browser eval --stdin <<'EOF'
const token = localStorage.getItem('logto:access_token:vpikk7sl9zwvefiptowtn') || '';
try {
  const payload = JSON.parse(atob(token.split('.')[1]));
  const now = Math.floor(Date.now() / 1000);
  JSON.stringify({ expired: now > payload.exp, exp: new Date(payload.exp * 1000).toISOString() })
} catch(e) { 'error: no token or invalid format' }
EOF
```

### 3. 启动浏览器 + 手动登录（方案 B，推荐）

如果 token 已过期或没有 token，使用此流程：

```bash
# 启动独立的测试浏览器 session（不影响你正在使用的浏览器）
agent-browser --session test-chat --headed open "https://dev.cohub.run"
agent-browser wait --load networkidle
agent-browser wait 2000

# 3. 此时浏览器会重定向到 Logto 登录页
# 告诉用户：「请在浏览器窗口中手动完成登录，登录好了告诉我」
# 用户登录完成后，继续执行：
```

**验证登录成功**：
```bash
agent-browser screenshot /tmp/verify_login.png
agent-browser get url
# 应该看到 dev.cohub.run 的页面，不再是登录页
# 左侧导航应显示：Explore, Workspaces, Channels
# 右侧应显示欢迎信息或 dashboard
```

> **重要**：测试过程中**不要关闭浏览器**。所有截图和验证都在同一个 session 中完成。
> 测试结束后也保持浏览器打开，方便用户手动检查。

### 4. 获取当前页面元素 refs

每个操作前都需要获取最新的 refs：

```bash
agent-browser snapshot -i
# 输出格式示例：
# - link "Explore" [ref=e1]
# - button "New Session" [ref=e2]
# - textbox "Message session..." [ref=e3]
# - button "Send" [ref=e4] [disabled]
```

> `@eX` 是动态生成的 ref，每次页面变化后都需要重新 snapshot 获取。

---

## 测试流程

### Phase 0: 准备测试数据（首次测试时执行）

如果没有现成的 workspace，需要先 fork 一个 public workspace：

#### 0.1 进入 Explore

```bash
agent-browser snapshot -i
agent-browser click @eX        # "Explore" 链接
agent-browser wait --load networkidle
agent-browser wait 2000
agent-browser screenshot /tmp/01_explore.png
```

#### 0.2 选择 Public Workspace

```bash
agent-browser snapshot -i
# 找到任意一个 public workspace（不固定名称，根据实际列表选择）
agent-browser click @eX        # workspace 名称链接
agent-browser wait --load networkidle
agent-browser wait 2000
agent-browser screenshot /tmp/02_workspace_detail.png
```

#### 0.3 Fork Workspace

```bash
agent-browser snapshot -i
agent-browser click @eX        # 右上角 "Fork" 按钮
agent-browser wait 3000
agent-browser get url
# URL 应从 /workspaces/{originalId} 变为 /workspaces/{newForkedId}
# 记录 newForkedId，后续创建 runtime 时使用
agent-browser screenshot /tmp/03_forked.png
```

#### 0.4 创建 Runtime

```bash
# 方式 A：从 workspace 详情页直接创建（如果有按钮）
agent-browser click "New Runtime"
# 方式 B：从首页创建
agent-browser open "https://dev.cohub.run"
agent-browser wait --load networkidle
agent-browser click "New Runtime"

agent-browser wait --load networkidle
agent-browser wait 2000
agent-browser snapshot -i
# 应该看到 workspace 选择列表
agent-browser check @eX        # 选中刚 fork 的 workspace
agent-browser wait 1000
agent-browser snapshot -i
# 验证表单字段：
# - Title（默认 workspace name，可改）
# - Start runtime immediately（默认勾选）
# - Environment Variables（可选）
# - Channel Bindings（可选）
agent-browser click @eX        # "Create Runtime" 按钮
agent-browser wait --load networkidle
```

#### 0.5 等待 Runtime 启动

```bash
agent-browser wait 10000
agent-browser screenshot /tmp/04_runtime_starting.png
# 状态指示器应显示 "WAIT_RUNTIME_RUNNING" 或类似启动中状态

# 持续轮询直到 RUNNING
agent-browser wait 30000
agent-browser screenshot /tmp/05_runtime_running.png
# 应该看到绿色圆点 + "RUNNING" 状态
```

#### 0.6 记录 Runtime ID

```bash
agent-browser get url
# URL 格式：https://dev.cohub.run/runtimes/{runtimeId}
# 记录 {runtimeId}，后续测试使用
```

> Phase 0 完成后，后续所有测试都在这个 runtime 下进行。
> 如果已有可用的 runtime，可跳过 Phase 0，直接进入 Phase 1。

---

### Phase 1: 单 Session 基础功能测试

> 目标：验证单 session 下的消息发送、流式响应、渲染等基础功能

#### 1.1 发送第一条消息

```bash
agent-browser snapshot -i
agent-browser fill @eX "Hello! Can you tell me about the world setting?"
agent-browser wait 1000
agent-browser snapshot -i
# 验证：Send 按钮应从 disabled 变为可用
agent-browser click @eX        # "Send" 按钮
agent-browser wait 30000       # 等待流式响应完成
agent-browser screenshot /tmp/p1_msg1_response.png
```

**验证点**：
- [ ] 用户消息正确显示在聊天区（靠右或特殊样式）
- [ ] Thinking 区域显示思考过程（可折叠/展开）
- [ ] Tool Call 卡片显示（工具名、输入参数）
- [ ] Markdown 渲染正常（标题、列表、代码块、表格、中英文混排）
- [ ] Token 用量显示（IN/OUT 数字）
- [ ] 输入框自动清空
- [ ] Send 按钮恢复可用（非 disabled）

#### 1.2 发送第二条消息（多轮对话）

```bash
agent-browser fill @eX "Can you give me more details about that?"
agent-browser click @eX        # "Send" 按钮
agent-browser wait 30000
agent-browser screenshot /tmp/p1_msg2_response.png
```

**验证点**：
- [ ] 上下文保持（agent 知道之前聊了什么）
- [ ] 新消息追加在旧消息下方
- [ ] 流式输出流畅，无卡顿或乱序
- [ ] 消息顺序正确（user → assistant → user → assistant）

#### 1.3 流式输出过程中的 UI 状态

```bash
# 发送一条会触发较长响应的消息
agent-browser fill @eX "Please explain everything in detail with examples."
agent-browser click @eX        # "Send" 按钮
agent-browser wait 5000        # 不要等太久，在流式输出中截图
agent-browser screenshot /tmp/p1_streaming_in_progress.png
```

**验证点**：
- [ ] Send 按钮在流式输出期间为 disabled
- [ ] 输入框不可编辑
- [ ] 流式文本实时追加（不是等全部生成后才显示）
- [ ] Thinking 区域实时展开/更新
- [ ] 如果有 Tool Call，卡片逐步显示

---

### Phase 2: 多 Session 流式体验测试（核心）

> 目标：验证多个 session 同时存在时的流式隔离、切换行为、状态管理

#### 2.1 创建第二个 Session

```bash
agent-browser snapshot -i
agent-browser click @eX        # "New Session" 按钮（右上角）
agent-browser wait 3000
agent-browser get url
# URL 应变为 ?session={newSessionId}
# 记录 newSessionId
agent-browser screenshot /tmp/p2_session2_created.png
```

**验证点**：
- [ ] URL 中的 session 参数正确更新
- [ ] 聊天区清空（新 session 无历史消息）
- [ ] 输入框可用

#### 2.2 场景 A：交替发送消息（并发流式）

```bash
# Session 2 发送消息
agent-browser fill @eX "What is the main topic here?"
agent-browser click @eX        # "Send"
agent-browser wait 3000        # 等待 3 秒，session 2 正在流式输出

# 此时不要等待完成，立即切换到 Session 1
agent-browser eval --stdin <<'EOF'
// 获取 session 1 的 ID（从之前的记录或 URL 历史）
const params = new URLSearchParams(window.location.search);
const currentSession = params.get('session');
// 这里需要你知道 session 1 的 ID
// 可以通过 sidebar 点击切换，或直接改 URL
window.history.pushState({}, '', window.location.pathname + '?session={session1Id}');
window.dispatchEvent(new PopStateEvent('popstate'));
window.location.href
EOF
agent-browser wait 3000
agent-browser screenshot /tmp/p2_session1_during_session2_streaming.png
```

**验证点**：
- [ ] Session 1 的历史消息完整显示
- [ ] Session 1 不应显示 Session 2 的流式内容
- [ ] 输入框可用，可发送新消息

```bash
# 在 Session 1 发送新消息
agent-browser fill @eX "Continue from our previous conversation."
agent-browser click @eX        # "Send"
agent-browser wait 30000
agent-browser screenshot /tmp/p2_session1_new_response.png
```

**验证点**：
- [ ] Session 1 的流式输出正常
- [ ] Session 2 的流式输出不受影响（切换回去验证）

#### 2.3 场景 B：Session 切换后的状态隔离

```bash
# 在 Session 1 流式输出时，切换回 Session 2
agent-browser eval --stdin <<'EOF'
window.history.pushState({}, '', window.location.pathname + '?session={session2Id}');
window.dispatchEvent(new PopStateEvent('popstate'));
EOF
agent-browser wait 5000
agent-browser screenshot /tmp/p2_switched_to_session2.png
```

**验证点**：
- [ ] Session 2 显示的是它自己的消息历史
- [ ] Session 2 不应显示 Session 1 的流式中间状态
- [ ] Session 2 之前的流式输出应已固化为历史消息（不应是 streaming 状态）
- [ ] 输入框可用

#### 2.4 场景 C：快速连续切换

```bash
# 在两个 session 之间快速切换 3 次
for i in 1 2 3; do
  agent-browser eval --stdin <<EOF
window.history.pushState({}, '', window.location.pathname + '?session={session1Id}');
window.dispatchEvent(new PopStateEvent('popstate'));
EOF
  agent-browser wait 1000
  agent-browser eval --stdin <<EOF
window.history.pushState({}, '', window.location.pathname + '?session={session2Id}');
window.dispatchEvent(new PopStateEvent('popstate'));
EOF
  agent-browser wait 1000
done
agent-browser screenshot /tmp/p2_rapid_switch.png
```

**验证点**：
- [ ] 最终显示的 session 内容正确
- [ ] 没有消息串 session
- [ ] 流式状态没有混乱

#### 2.5 SSE 连接行为观察

```bash
# 查看网络请求
agent-browser network requests --method GET
# 应该看到 /api/runtimes/{id}/stream 的请求

# 检查请求详情
agent-browser network requests --status 2xx | grep stream
```

**验证点**：
- [ ] 只有一个 SSE 连接（当前实现）
- [ ] SSE 连接在页面加载时建立
- [ ] SSE 连接在页面切换时是否断开重连

---

### Phase 3: 边缘场景测试

#### 3.1 Sidebar Sessions 列表

```bash
agent-browser screenshot /tmp/p3_sidebar_sessions.png
```

**验证点**：
- [ ] 左侧 RUNTIMES 下是否正确显示已创建的 session
- [ ] 当前 active session 是否有高亮标识
- [ ] 点击 sidebar 中的 session 是否能正确切换
- [ ] 新建 session 后 sidebar 是否实时更新

#### 3.2 快速连续发送消息

```bash
# Session 1 发送消息
agent-browser fill @eX "Message 1"
agent-browser click @eX        # "Send"

# 不等响应，立即发送第二条（此时 Send 应该是 disabled）
agent-browser fill @eX "Message 2"
agent-browser click @eX        # "Send"（如果还是 disabled，说明前端做了防重复提交）

agent-browser wait 10000
agent-browser screenshot /tmp/p3_rapid_send.png
```

**验证点**：
- [ ] 如果 Send 是 disabled，第二条消息应该无法发送（符合预期）
- [ ] 如果 Send 变为可用，第二条消息发送后，流式输出是否正常
- [ ] 消息顺序是否正确

#### 3.3 长时间无操作后的 SSE 重连

```bash
# 等待较长时间（模拟用户离开）
agent-browser wait 120000      # 2 分钟

# 发送新消息，观察 SSE 是否正常
agent-browser fill @eX "Are you still there?"
agent-browser click @eX        # "Send"
agent-browser wait 30000
agent-browser screenshot /tmp/p3_reconnect.png
```

**验证点**：
- [ ] SSE 连接是否自动重连
- [ ] 流式响应是否正常
- [ ] 是否有重连相关的错误提示

#### 3.4 空消息/特殊字符

```bash
# 测试空消息（应该无法发送）
agent-browser fill @eX "   "
agent-browser snapshot -i
# 验证：Send 按钮应该是 disabled

# 测试特殊字符
agent-browser fill @eX "测试特殊字符：<script>alert('xss')</script> & \"quotes\" & 'apostrophes'"
agent-browser click @eX        # "Send"
agent-browser wait 15000
agent-browser screenshot /tmp/p3_special_chars.png
```

**验证点**：
- [ ] 空消息无法发送
- [ ] 特殊字符正确转义，不导致 XSS 或渲染错误
- [ ] 中英文混排正常

#### 3.5 超长消息

```bash
# 发送超长消息（如果前端有长度限制）
agent-browser eval --stdin <<'EOF'
const input = document.querySelector('[placeholder="Message session..."]');
if (input) {
  input.value = 'A'.repeat(5000);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
EOF
agent-browser snapshot -i
# 验证：Send 按钮状态，是否有长度提示
```

---

### Phase 4: 设置面板测试

#### 4.1 打开/关闭设置

```bash
agent-browser snapshot -i
agent-browser click @eX        # Settings 按钮（右上角齿轮图标）
agent-browser wait 2000
agent-browser screenshot /tmp/p4_settings_open.png
```

**验证点**：
- [ ] 设置面板从右侧滑出
- [ ] 聊天区域自动缩小（如果有响应式布局）
- [ ] 面板内容正确显示

#### 4.2 Channel 配置

```bash
# 如果有绑定 channel，验证配置项
agent-browser snapshot -i
# 验证 checkbox、开关等交互元素
agent-browser screenshot /tmp/p4_channel_config.png
```

---

## 代码层面分析

### 前端 SSE 实现 (`apps/web/src/routes/runtimes/[id]/+page.svelte`)

```typescript
// 关键代码 1：单例 SSE 连接
function startSSE() {
  if (sseAbortController) return;  // 只启动一次，不随 session 切换重连
  sseAbortController = new AbortController();
  // ...
  for await (const event of streamRuntimeEvents(runtimeId, ...)) {
    void handleSSEEvent(event);
  }
}

// 关键代码 2：客户端过滤非当前 session 的事件
function handleSSEEvent(event: RuntimeStreamEvent) {
  if (activeSessionId == null || event.sessionId !== activeSessionId) return;
  // 非当前 session 的事件被直接丢弃，包括 turnEnd
}

// 关键代码 3：切换 session 时清空流式状态
$effect(() => {
  void activeSessionId;
  clearStreamingState();  // 清空 streamingAssistantText, streamingThinking, streamingToolCalls
});
```

### 前端 API 层 (`apps/web/src/lib/api.ts`)

```typescript
// SSE 流式读取
export const streamRuntimeEvents = async function* (
  runtimeId: string,
  lastEventId?: string,
  signal?: AbortSignal,
) {
  // ...
  for await (const data of readSseEvents(response)) {
    try {
      yield JSON.parse(data) as RuntimeStreamEvent;
    } catch {
      // Skip non-JSON events (e.g. "ready" event)
    }
  }
};
```

**需要关注的点**：
- `readSseEvents` 的 buffer 处理是否正确（`\n\n` 和 `\r\n\r\n` 边界）
- 非 JSON 事件（如 "ready"）是否会导致解析错误
- `lastEventId` 在重连时是否正确传递

### 后端 SSE 端点

```bash
# 查看实现
find apps/api -name "*.ts" | xargs grep -l "stream\|SSE\|text/event-stream" 2>/dev/null
```

**需要验证**：
- [ ] SSE 端点是否支持按 `sessionId` 过滤
- [ ] 事件格式中 `sessionId` 字段是否正确
- [ ] 多 session 并发时事件是否可能交叉
- [ ] `turnEnd` 事件是否在每次响应结束时正确发送

---

## 已确认的问题

### P0 - SSE 架构缺陷

**现象**：
- 一个 runtime 只有**一个** SSE 连接
- 所有 session 的流式事件都通过同一个连接推送
- 客户端用 `activeSessionId` 过滤非当前 session 的事件
- 切换 session 时，之前 session 的剩余事件（包括 `turnEnd`）被丢弃

**风险**：
- Session A 的 `turnEnd` 事件丢失 → 不会触发 `loadSessionState()` → Session A 状态不一致
- 如果后端事件顺序错乱，Session B 可能收到 Session A 的事件片段
- SSE 重连时可能丢失事件

**修复方向**：
- 方案 A：每个 active session 独立维护一个 SSE 连接
- 方案 B：后端 SSE 端点支持 `sessionId` 参数过滤
- 方案 C：客户端维护每个 session 的 lastEventId，切换时正确恢复

### P1 - Sidebar Sessions 列表不更新

**现象**：
- 创建 session 后，sidebar 一直显示 "No sessions"
- API 请求 `/api/runtimes/{id}/sessions` 返回正确数据
- 但 sidebar 组件没有正确更新

**可能原因**：
- `seedSessions()` 状态同步问题
- Svelte 响应式更新链路断裂
- Sidebar 组件依赖的数据源未正确传递

**修复方向**：
- 检查 `Sidebar.svelte` 和 `+page.svelte` 的数据流
- 验证 `runtimeSessions` 状态是否正确更新
- 检查 Svelte `$derived` 和 `$state` 的响应式链路

### P2 - 切换 Session 时状态恢复

**现象**：
- 切换回之前的 session，流式中间状态丢失
- 只能依赖 `loadSessionState()` 加载历史消息
- 如果 `turnEnd` 事件丢失，可能导致加载不完整

**修复方向**：
- 确保 `turnEnd` 事件不丢失（P0 修复后自然解决）
- 或者在切换时主动调用 `loadSessionState()` 确保状态同步

---

## 测试数据记录模板

每次测试后填写此表：

| 测试项 | 状态 | 备注/截图 |
|--------|------|-----------|
| Phase 0: 准备测试数据 | | |
| Explore + Fork | | |
| 创建 Runtime | | |
| Runtime 启动 | | |
| Phase 1: 单 Session 基础 | | |
| 第 1 条消息 | | |
| 第 2 条消息 | | |
| 流式 UI 状态 | | |
| Phase 2: 多 Session 流式 | | |
| 创建 Session 2 | | |
| 交替发送（并发） | | |
| Session 切换隔离 | | |
| 快速连续切换 | | |
| SSE 连接行为 | | |
| Phase 3: 边缘场景 | | |
| Sidebar Sessions | | |
| 快速连续发送 | | |
| SSE 重连 | | |
| 空消息/特殊字符 | | |
| Phase 4: 设置面板 | | |
| 打开/关闭 | | |
| Channel 配置 | | |

---

## 截图记录模板

| 文件名 | 说明 | 对应测试项 |
|--------|------|------------|
| `/tmp/01_explore.png` | Explore 页面 | Phase 0.1 |
| `/tmp/02_workspace_detail.png` | Workspace 详情 | Phase 0.2 |
| `/tmp/03_forked.png` | Fork 后页面 | Phase 0.3 |
| `/tmp/04_runtime_starting.png` | Runtime 启动中 | Phase 0.5 |
| `/tmp/05_runtime_running.png` | Runtime RUNNING | Phase 0.5 |
| `/tmp/p1_msg1_response.png` | 第 1 条消息响应 | Phase 1.1 |
| `/tmp/p1_msg2_response.png` | 第 2 条消息响应 | Phase 1.2 |
| `/tmp/p1_streaming_in_progress.png` | 流式输出中 | Phase 1.3 |
| `/tmp/p2_session2_created.png` | Session 2 创建 | Phase 2.1 |
| `/tmp/p2_session1_during_session2_streaming.png` | Session 2 流式时看 Session 1 | Phase 2.2 |
| `/tmp/p2_session1_new_response.png` | Session 1 新响应 | Phase 2.2 |
| `/tmp/p2_switched_to_session2.png` | 切换回 Session 2 | Phase 2.3 |
| `/tmp/p2_rapid_switch.png` | 快速切换 | Phase 2.4 |
| `/tmp/p3_sidebar_sessions.png` | Sidebar Sessions | Phase 3.1 |
| `/tmp/p3_rapid_send.png` | 快速连续发送 | Phase 3.2 |
| `/tmp/p3_reconnect.png` | SSE 重连 | Phase 3.3 |
| `/tmp/p3_special_chars.png` | 特殊字符 | Phase 3.4 |
| `/tmp/p4_settings_open.png` | 设置面板 | Phase 4.1 |
| `/tmp/p4_channel_config.png` | Channel 配置 | Phase 4.2 |

---

## 常见问题排查

### Q: Snapshot 找不到预期元素
```bash
# 先截图看当前页面状态
agent-browser screenshot /tmp/debug_current.png

# 再获取完整文本内容
agent-browser get text body | head -50

# 检查是否有弹窗/遮罩层
agent-browser eval --stdin <<'EOF'
document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="dialog"]')
  .map(el => el.textContent.trim()).join(' | ')
EOF
```

### Q: 点击后页面无反应
```bash
# 检查按钮是否被遮挡
agent-browser eval --stdin <<'EOF'
const btn = document.querySelector('button[class*="send"]');
if (btn) {
  const rect = btn.getBoundingClientRect();
  const elementAtPoint = document.elementFromPoint(
    rect.left + rect.width/2,
    rect.top + rect.height/2
  );
  JSON.stringify({
    button: btn.textContent.trim(),
    elementAtPoint: elementAtPoint?.tagName + '.' + elementAtPoint?.className,
    disabled: btn.disabled
  })
}
EOF
```

### Q: SSE 连接异常
```bash
# 查看网络请求
agent-browser network requests | grep -i stream

# 查看请求详情
agent-browser network request <requestId>
```

### Q: Token 过期
```bash
# 重新登录（使用独立 session）
agent-browser --session test-chat open "https://dev.cohub.run"
# 等待用户手动登录...
```

---

## 下次测试前检查清单

- [ ] Token 是否有效（或准备手动登录）
- [ ] 浏览器是否干净（`agent-browser close --all`，但测试中不要 close）
- [ ] 是否有可用的 runtime（或准备 Phase 0）
- [ ] 记录 runtimeId 和 sessionIds
- [ ] 清理旧截图（`rm /tmp/p*.png /tmp/0*.png`）
- [ ] 确认测试环境（dev / staging / prod）
- [ ] 确认后端服务正常（API 可访问）

---

## 测试后清理（可选）

```bash
# 如果创建了测试用的 workspace/runtime，可以删除
# 注意：不要删除用户的数据

# 清理测试 session（仅在所有测试完成后，且用户确认不需要再检查时）
# agent-browser --session test-chat close
```

> **注意**：测试过程中不要关闭浏览器。文档中的命令均假设浏览器 session 持续存在。

---

> 文档版本：v2.0
> 最后更新：2026-04-07
> 测试环境：dev.cohub.run
> 适用环境：dev / staging（URL 和 auth 配置可能需要调整）
