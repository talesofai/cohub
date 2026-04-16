<script lang="ts">
type ChatBubble = {
  role: "system" | "user";
  content: string;
};

let draft = $state("");
const messages = $state<ChatBubble[]>([
  {
    role: "system",
    content: "Space chat preview placeholder.",
  },
]);

const submit = () => {
  const value = draft.trim();
  if (!value) {
    return;
  }

  messages.push({ role: "user", content: value });
  draft = "";
};
</script>

<section class="chat-panel">
  <header class="chat-header">
    <strong>Workspace Chat</strong>
    <span class="badge">Placeholder</span>
  </header>

  <div class="chat-body">
    {#each messages as message, index (index)}
      <div class={`bubble ${message.role}`}>
        {message.content}
      </div>
    {/each}
  </div>

  <footer class="chat-footer">
    <input
      bind:value={draft}
      onkeydown={(event) => {
        if (event.key === "Enter") {
          submit();
        }
      }}
      placeholder="Type a message"
      type="text"
    />
    <button onclick={submit} type="button">Send</button>
  </footer>
</section>

<style>
  .chat-panel {
    height: 100%;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .chat-header {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .badge {
    font-size: 11px;
    color: var(--text-soft);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
  }

  .chat-body {
    flex: 1;
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .bubble {
    border-radius: 8px;
    padding: 10px;
    font-size: 13px;
    line-height: 1.5;
  }

  .bubble.system {
    background: var(--panel-soft);
    color: var(--text-soft);
  }

  .bubble.user {
    background: var(--accent-soft);
    color: #d9e1ff;
    align-self: flex-end;
    max-width: 90%;
  }

  .chat-footer {
    border-top: 1px solid var(--border);
    padding: 10px;
    display: flex;
    gap: 8px;
  }

  input {
    flex: 1;
    background: #121722;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 10px;
    outline: none;
  }

  button {
    background: var(--accent);
    color: white;
    border: 0;
    border-radius: 8px;
    padding: 0 12px;
    cursor: pointer;
  }
</style>
