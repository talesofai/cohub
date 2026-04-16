<script lang="ts">
import { onMount } from "svelte";
import {
  getCronJobs,
  createCronJob,
  createScheduledTask,
  deleteCronJob,
  toggleCronJob,
  getTaskRuns,
  getSpaces,
  type CronJobRecord,
  type TaskRunRecord,
  type SpaceRecord,
} from "$lib/api";
import { logtoClient } from "$lib/auth";
import { Plus, Trash2, Power, PowerOff, Loader2, Clock, Activity, Filter, X, Clipboard, ClipboardCheck } from "lucide-svelte";
import PageHeader from "$lib/components/PageHeader.svelte";

type TabId = "cronjobs" | "history";
type ModalMode = "create" | "edit";

let activeTab: TabId = $state("cronjobs");
let isLoading = $state(true);
let loadError = $state("");
let cronJobs = $state<CronJobRecord[]>([]);
let taskRuns = $state<TaskRunRecord[]>([]);
let filterCronJobId = $state<string | null>(null);
let actionInProgress = $state<Record<string, string>>({});

// ── Modal state ──
let showCreateModal = $state(false);
let modalMode = $state<ModalMode>("create");
let editingJob: CronJobRecord | null = $state(null);
let isCreating = $state(false);
let createType = $state<"repeating" | "onetime">("repeating");
let createTitle = $state("");
let createCronExpression = $state("");
let createScheduleAt = $state("");
let createSpaceId = $state("");
let createPromptText = $state("");
let createError = $state("");
let spaces = $state<SpaceRecord[]>([]);
let copiedIndex = $state<number | null>(null);

// Derived booleans to avoid TS narrowing issues in templates
let isEditMode = $derived(modalMode === "edit");
let isRepeatingType = $derived(createType === "repeating");
let isOnetimeType = $derived(createType === "onetime");

// Example prompts — create (2 items for mobile fit)
const createExamplePrompts = [
  "Every day at 10 AM, send a daily report summary to this space",
  "Remind me to check the deployment status in 5 minutes",
];

// Example prompts — edit mode
const editExamplePrompts = [
  "Change the schedule to every Monday at 9 AM",
  "Update the prompt message to include error counts",
];

function getExamplePrompts(): string[] {
  return modalMode === "edit" ? editExamplePrompts : createExamplePrompts;
}

function copyPrompt(text: string, index: number) {
  navigator.clipboard.writeText(text).then(() => {
    copiedIndex = index;
    setTimeout(() => { copiedIndex = null; }, 1500);
  });
}

function extractPromptText(payload: Record<string, unknown>): string {
  const content = payload.content as Array<{ type: string; text: string }> | undefined;
  if (Array.isArray(content)) {
    const textBlock = content.find((c) => c.type === "text");
    return textBlock?.text ?? "";
  }
  return "";
}

async function loadCronJobs() {
  if (!(await logtoClient.isAuthenticated())) {
    isLoading = false;
    return;
  }

  loadError = "";
  try {
    const result = await getCronJobs();
    cronJobs = result.jobs ?? [];
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load cron jobs";
  } finally {
    isLoading = false;
  }
}

async function loadTaskRuns() {
  if (!(await logtoClient.isAuthenticated())) {
    return;
  }

  try {
    const result = await getTaskRuns();
    taskRuns = result.runs ?? [];
  } catch (error) {
    console.warn("Failed to load task runs", error);
  }
}

async function handleDelete(id: string, e: Event) {
  e.stopPropagation();
  if (!confirm("Are you sure you want to delete this cron job?")) return;
  actionInProgress = { ...actionInProgress, [id]: "delete" };
  try {
    await deleteCronJob(id);
    await loadCronJobs();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Failed to delete");
  } finally {
    const { [id]: _, ...rest } = actionInProgress;
    actionInProgress = rest;
  }
}

async function handleToggle(id: string, enabled: boolean, e: Event) {
  e.stopPropagation();
  actionInProgress = { ...actionInProgress, [id]: "toggle" };
  try {
    await toggleCronJob(id, enabled);
    cronJobs = cronJobs.map((j) => (j.id === id ? { ...j, enabled } : j));
  } catch (error) {
    alert(error instanceof Error ? error.message : "Failed to toggle");
    await loadCronJobs();
  } finally {
    const { [id]: _, ...rest } = actionInProgress;
    actionInProgress = rest;
  }
}

function filterHistoryForJob(jobId: string) {
  filterCronJobId = jobId;
  activeTab = "history";
}

function clearFilter() {
  filterCronJobId = null;
}

async function loadSpaces() {
  try {
    const data = await getSpaces();
    spaces = data ?? [];
  } catch (error) {
    console.warn("[Jobs] Failed to load spaces", error);
  }
}

function openCreateModal() {
  showCreateModal = true;
  modalMode = "create";
  editingJob = null;
  isCreating = false;
  createType = "repeating";
  createTitle = "";
  createCronExpression = "";
  createScheduleAt = "";
  createSpaceId = spaces[0]?.id ?? "";
  createPromptText = "";
  createError = "";
  copiedIndex = null;
  void loadSpaces();
}

function openEditModal(job: CronJobRecord) {
  showCreateModal = true;
  modalMode = "edit";
  editingJob = job;
  isCreating = false;
  createType = "repeating";
  createTitle = job.title;
  createCronExpression = job.cronExpression;
  createScheduleAt = "";
  createSpaceId = job.spaceId ?? "";
  createPromptText = extractPromptText(job.payload as Record<string, unknown>);
  createError = "";
  copiedIndex = null;
  void loadSpaces();
}

function closeCreateModal() {
  if (isCreating) return;
  showCreateModal = false;
}

function handleModalBackdropKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closeCreateModal();
}

async function handleCreate() {
  createError = "";
  if (isCreating) return;

  if (modalMode === "edit" && editingJob) {
    // Edit mode: only update prompt and cron expression via delete+recreate
    // For simplicity, delete old and create new
    if (!createTitle.trim()) {
      createError = "Title is required";
      return;
    }
    if (!createPromptText.trim()) {
      createError = "Prompt message is required";
      return;
    }
    if (!createCronExpression.trim()) {
      createError = "Cron expression is required";
      return;
    }

    isCreating = true;
    try {
      // Delete old cron job
      await deleteCronJob(editingJob.id);

      // Create new one with updated values
      await createCronJob({
        title: createTitle.trim(),
        taskType: "send_message",
        payload: {
          content: [{ type: "text", text: createPromptText.trim() }],
        },
        cronExpression: createCronExpression.trim(),
        spaceId: createSpaceId || undefined,
      });

      showCreateModal = false;
      await loadCronJobs();
      await loadTaskRuns();
    } catch (error) {
      createError = error instanceof Error ? error.message : "Failed to update";
    } finally {
      isCreating = false;
    }
    return;
  }

  // Create mode
  if (!createPromptText.trim()) {
    createError = "Prompt message is required";
    return;
  }
  if (!createSpaceId) {
    createError = "Space is required";
    return;
  }

  isCreating = true;
  try {
    if (createType === "repeating") {
      if (!createTitle.trim()) {
        createError = "Title is required";
        return;
      }
      if (!createCronExpression.trim()) {
        createError = "Cron expression is required";
        return;
      }
      const cronParts = createCronExpression.trim().split(/\s+/);
      if (cronParts.length < 5 || cronParts.length > 6) {
        createError = "Invalid cron expression format. Expected 5 or 6 space-separated fields (min hour day month weekday [year])";
        return;
      }
      await createCronJob({
        title: createTitle.trim(),
        taskType: "send_message",
        payload: {
          content: [{ type: "text", text: createPromptText.trim() }],
        },
        cronExpression: createCronExpression.trim(),
        spaceId: createSpaceId || undefined,
      });
    } else {
      if (!createScheduleAt) {
        createError = "Schedule time is required";
        return;
      }
      const scheduleTime = new Date(createScheduleAt);
      if (Number.isNaN(scheduleTime.getTime()) || scheduleTime.getTime() <= Date.now()) {
        createError = "Schedule time must be in the future";
        return;
      }
      await createScheduledTask({
        taskType: "send_message",
        payload: {
          content: [{ type: "text", text: createPromptText.trim() }],
        },
        scheduleAt: scheduleTime.toISOString(),
        spaceId: createSpaceId || undefined,
      });
    }
    showCreateModal = false;
    await loadCronJobs();
    await loadTaskRuns();
  } catch (error) {
    createError = error instanceof Error ? error.message : "Failed to create";
  } finally {
    isCreating = false;
  }
}

function statusBadge(run: TaskRunRecord) {
  switch (run.status) {
    case "completed":
      return { label: "Completed", color: "text-status-running", dot: "bg-status-running" };
    case "failed":
      return { label: "Failed", color: "text-status-error", dot: "bg-status-error" };
    case "running":
      return { label: "Running", color: "text-info", dot: "bg-info" };
    case "pending":
      return { label: "Pending", color: "text-warning", dot: "bg-warning" };
    default:
      return { label: run.status, color: "text-text-placeholder", dot: "bg-text-placeholder" };
  }
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getJobTitle(cronJobId: string | null) {
  if (!cronJobId) return null;
  const job = cronJobs.find((j) => j.id === cronJobId);
  return job?.title ?? null;
}

function formatScheduled(dateStr: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const filteredRuns = $derived(
  filterCronJobId ? taskRuns.filter((r) => r.cronJobId === filterCronJobId) : taskRuns
);

$effect(() => {
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showCreateModal && !isCreating) {
      closeCreateModal();
    }
  }
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
});

onMount(() => {
  void loadCronJobs();
  void loadTaskRuns();
});
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <!-- Header -->
  <PageHeader>
    {#snippet left()}
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class={`px-2 py-1 rounded-[5px] text-[12px] font-medium transition-colors duration-100 ${activeTab === "cronjobs" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"}`}
          onclick={() => { activeTab = "cronjobs"; }}
        >
          <span class="flex items-center gap-1.5">
            <Clock class="w-3.5 h-3.5" />
            Cronjobs
          </span>
        </button>
        <button
          type="button"
          class={`px-2 py-1 rounded-[5px] text-[12px] font-medium transition-colors duration-100 ${activeTab === "history" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"}`}
          onclick={() => { activeTab = "history"; void loadTaskRuns(); }}
        >
          <span class="flex items-center gap-1.5">
            <Activity class="w-3.5 h-3.5" />
            History
          </span>
        </button>
      </div>
    {/snippet}
    {#snippet right()}
      <button
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100"
        onclick={openCreateModal}
      >
        <Plus class="w-3.5 h-3.5" />
        <span class="hidden sm:inline">New Task</span>
      </button>
    {/snippet}
  </PageHeader>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto">
    {#if activeTab === "cronjobs"}
      <!-- Cronjobs Tab -->
      <div class="px-4 py-3">
        {#if isLoading}
          <div class="flex items-center justify-center gap-2 py-12 text-text-tertiary text-[13px]">
            <Loader2 class="w-4 h-4 animate-spin" />
            Loading...
          </div>
        {:else if loadError}
          <div class="py-4 text-center text-error-soft text-[13px]">{loadError}</div>
        {:else if cronJobs.length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center">
            <Clock class="w-8 h-8 text-text-placeholder mb-3" />
            <p class="text-[14px] font-medium text-text-secondary">No cronjobs yet</p>
            <p class="text-[12px] text-text-placeholder mt-1">Create a scheduled task to automate your workflows</p>
          </div>
        {:else}
          <div class="divide-y divide-border-subtle/40">
            {#each cronJobs as job (job.id)}
              {@const isBusy = actionInProgress[job.id]}
              <div class="group flex items-center gap-3 px-3 py-3 hover:bg-bg-hover/30 transition-colors">
                <!-- Status dot -->
                <span class="w-2 h-2 rounded-full shrink-0 {job.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>

                <!-- Title (clickable to edit) -->
                <button
                  type="button"
                  class="flex-1 min-w-0 text-left text-[14px] font-medium truncate hover:text-brand transition-colors"
                  onclick={() => openEditModal(job)}
                  title="Edit"
                >
                  {job.title}
                </button>

                <!-- Cron expression — pill on desktop, hidden on mobile -->
                <span class="text-[11px] font-mono text-text-placeholder px-2 py-0.5 rounded bg-bg-code hidden md:inline">{job.cronExpression}</span>

                <!-- Actions — hover on desktop, always on mobile -->
                <div class="flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <!-- History filter -->
                  <button
                    type="button"
                    class="p-1.5 rounded-[5px] hover:bg-bg-hover text-text-tertiary hover:text-brand transition-colors"
                    title="View history"
                    onclick={() => filterHistoryForJob(job.id)}
                  >
                    <Filter class="w-3.5 h-3.5" />
                  </button>
                  <!-- Enable/disable toggle -->
                  <button
                    type="button"
                    class="p-1.5 rounded-[5px] hover:bg-bg-hover transition-colors {job.enabled ? 'text-text-tertiary hover:text-status-running' : 'text-text-placeholder hover:text-status-running'}"
                    title={job.enabled ? "Disable" : "Enable"}
                    onclick={(e) => handleToggle(job.id, !job.enabled, e)}
                  >
                    {#if isBusy}
                      <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    {:else if job.enabled}
                      <Power class="w-3.5 h-3.5" />
                    {:else}
                      <PowerOff class="w-3.5 h-3.5" />
                    {/if}
                  </button>
                  <!-- Delete -->
                  <button
                    type="button"
                    class="p-1.5 rounded-[5px] hover:bg-bg-hover text-text-placeholder hover:text-error-soft transition-colors"
                    title="Delete"
                    onclick={(e) => handleDelete(job.id, e)}
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else}
      <!-- History Tab -->
      <div class="px-4 py-3">
        <!-- Filter bar -->
        {#if filterCronJobId}
          {@const jobTitle = getJobTitle(filterCronJobId)}
          <div class="flex items-center gap-2 mb-2 px-1">
            <span class="text-[11px] text-text-tertiary">Filtered by</span>
            <span class="text-[11px] font-medium text-text-primary">{jobTitle ?? filterCronJobId}</span>
            <button type="button" class="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors" onclick={clearFilter} title="Clear filter">
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
        {/if}

        {#if filteredRuns.length === 0}
          <div class="flex flex-col items-center justify-center py-20 text-center">
            <Activity class="w-8 h-8 text-text-placeholder mb-3" />
            {#if filterCronJobId}
              <p class="text-[14px] font-medium text-text-secondary">No runs for this cronjob</p>
            {:else}
              <p class="text-[14px] font-medium text-text-secondary">No task run records</p>
              <p class="text-[12px] text-text-placeholder mt-1">Task runs will appear here once cronjobs start executing</p>
            {/if}
          </div>
        {:else}
          <!-- Desktop table -->
          <table class="hidden md:block w-full text-[13px]">
            <thead>
              <tr class="text-[10px] font-medium uppercase tracking-[0.08em] text-text-placeholder border-b border-border-subtle">
                <th class="text-left py-2.5 pr-4">Status</th>
                <th class="text-left py-2.5 pr-4">Source</th>
                <th class="text-left py-2.5 pr-4">Scheduled</th>
                <th class="text-left py-2.5 pr-4">Started</th>
                <th class="text-left py-2.5 pr-4">Duration</th>
                <th class="text-left py-2.5">Error</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-subtle/30">
              {#each filteredRuns as run (run.id)}
                {@const badge = statusBadge(run)}
                {@const duration = run.startedAt && run.finishedAt
                  ? (() => {
                      const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
                      return `${(ms / 1000).toFixed(1)}s`;
                    })()
                  : "—"}
                <tr class="hover:bg-bg-hover/30 transition-colors">
                  <td class="py-3 pr-4">
                    <span class="flex items-center gap-2">
                      <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                      <span class="{badge.color}">{badge.label}</span>
                    </span>
                  </td>
                  <td class="py-3 pr-4">
                    {#if run.cronJobId}
                      <button
                        type="button"
                        class="text-left text-[13px] text-text-secondary hover:text-brand transition-colors truncate max-w-[200px]"
                        onclick={() => {
                          filterCronJobId = run.cronJobId;
                        }}
                      >
                        {getJobTitle(run.cronJobId) ?? "—"}
                      </button>
                    {:else}
                      <span class="text-[13px] text-text-placeholder">One-time</span>
                    {/if}
                  </td>
                  <td class="py-3 pr-4 text-text-placeholder">{formatScheduled(run.scheduledAt)}</td>
                  <td class="py-3 pr-4 text-text-placeholder">{formatDate(run.startedAt ?? run.createdAt)}</td>
                  <td class="py-3 pr-4 text-text-placeholder font-mono">{duration}</td>
                  <td class="py-3 text-status-error max-w-[280px] truncate" title={run.errorMessage ?? ""}>
                    {run.errorMessage ?? "—"}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>

          <!-- Mobile cards -->
          <div class="md:hidden divide-y divide-border-subtle/30">
            {#each filteredRuns as run (run.id)}
              {@const badge = statusBadge(run)}
              {@const duration = run.startedAt && run.finishedAt
                ? (() => {
                    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
                    return `${(ms / 1000).toFixed(1)}s`;
                  })()
                : "—"}
              <div class="py-3">
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="flex items-center gap-1.5">
                    <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                    <span class="text-[13px] font-medium {badge.color}">{badge.label}</span>
                  </span>
                  {#if run.cronJobId}
                    <button
                      type="button"
                      class="ml-auto text-[11px] text-text-secondary hover:text-brand transition-colors"
                      onclick={() => { filterCronJobId = run.cronJobId; }}
                    >
                      {getJobTitle(run.cronJobId) ?? "—"}
                    </button>
                  {:else}
                    <span class="ml-auto text-[11px] text-text-placeholder">One-time</span>
                  {/if}
                </div>
                <div class="flex items-center gap-4 text-[11px] text-text-placeholder">
                  <span>{formatScheduled(run.scheduledAt)}</span>
                  <span>{formatDate(run.startedAt ?? run.createdAt)}</span>
                  <span class="font-mono">{duration}</span>
                </div>
                {#if run.errorMessage}
                  <p class="text-[11px] text-status-error mt-1 truncate">{run.errorMessage}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Create/Edit Modal -->
{#if showCreateModal}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    role="presentation"
    aria-hidden="true"
    onclick={closeCreateModal}
    onkeydown={(e) => { if (e.key === 'Escape') closeCreateModal(); }}
  >
    <div
      class="w-full max-w-2xl rounded-xl bg-bg-primary border border-border-subtle shadow-2xl mx-4"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="modal-title"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') closeCreateModal(); }}
    >
      <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <h2 id="modal-title" class="text-[14px] font-semibold">{isEditMode ? 'Edit Cronjob' : 'New Task'}</h2>
        <button type="button" class="text-text-tertiary hover:text-text-primary" aria-label="Close" onclick={closeCreateModal}>
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="px-4 py-3 space-y-4">
        {#if isEditMode}
          <!-- Edit mode -->
          <div>
            <p class="text-[12px] text-text-tertiary mb-2">Edit via Agent — or fill the form below:</p>
            <div class="flex flex-col gap-1.5 mb-3">
              {#each editExamplePrompts as prompt, i}
                <button
                  type="button"
                  class="w-full text-left text-[12px] text-text-secondary hover:text-text-primary transition-colors flex items-center justify-between gap-2 py-1 group/prompt"
                  onclick={() => copyPrompt(prompt, i)}
                >
                  <span class="leading-relaxed flex-1">{prompt}</span>
                  <span class="shrink-0 text-text-placeholder group-hover/prompt:text-brand transition-colors">
                    {#if copiedIndex === i}
                      <ClipboardCheck class="w-3.5 h-3.5 text-status-running" />
                    {:else}
                      <Clipboard class="w-3.5 h-3.5" />
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <div class="space-y-3">
            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-title">Name</label>
              <input
                id="task-title"
                type="text"
                bind:value={createTitle}
                placeholder="e.g. Daily report"
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 placeholder:text-text-placeholder"
              />
            </div>

            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-space">Target Space</label>
              <select
                id="task-space"
                bind:value={createSpaceId}
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 text-text-primary"
              >
                <option value="">— Select —</option>
                {#each spaces as space (space.id)}
                  <option value={space.id}>{space.name || space.id.slice(0, 12)}</option>
                {/each}
              </select>
            </div>

            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-expression">Cron Expression</label>
              <input
                id="task-expression"
                type="text"
                bind:value={createCronExpression}
                placeholder="e.g. 0 10 * * *"
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] font-mono outline-none focus:border-brand/50 placeholder:text-text-placeholder"
              />
            </div>

            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-prompt">Prompt Message</label>
              <textarea
                id="task-prompt"
                bind:value={createPromptText}
                rows="2"
                placeholder="Message content to send to the space..."
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 placeholder:text-text-placeholder resize-none"
              ></textarea>
            </div>
          </div>
        {:else}
          <!-- Create mode -->
          <div>
            <p class="text-[12px] text-text-tertiary mb-2">Create via Agent — or fill the form below:</p>
            <div class="flex flex-col gap-1.5 mb-1">
              {#each createExamplePrompts as prompt, i}
                <button
                  type="button"
                  class="w-full text-left text-[12px] text-text-secondary hover:text-text-primary transition-colors flex items-center justify-between gap-2 py-1 group/prompt"
                  onclick={() => copyPrompt(prompt, i)}
                >
                  <span class="leading-relaxed flex-1">{prompt}</span>
                  <span class="shrink-0 text-text-placeholder group-hover/prompt:text-brand transition-colors">
                    {#if copiedIndex === i}
                      <ClipboardCheck class="w-3.5 h-3.5 text-status-running" />
                    {:else}
                      <Clipboard class="w-3.5 h-3.5" />
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Type toggle -->
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="px-2.5 py-1 text-[12px] font-medium rounded transition-colors {isRepeatingType ? 'text-text-primary bg-bg-active' : 'text-text-tertiary hover:text-text-secondary'}"
              onclick={() => { createType = "repeating"; }}
            >
              <span class="flex items-center gap-1.5">
                <Clock class="w-3.5 h-3.5" />
                Repeating
              </span>
            </button>
            <button
              type="button"
              class="px-2.5 py-1 text-[12px] font-medium rounded transition-colors {isOnetimeType ? 'text-text-primary bg-bg-active' : 'text-text-tertiary hover:text-text-secondary'}"
              onclick={() => { createType = "onetime"; }}
            >
              <span class="flex items-center gap-1.5">
                <Activity class="w-3.5 h-3.5" />
                One-time
              </span>
            </button>
          </div>

          <!-- Form fields -->
          <div class="space-y-3">
            {#if isRepeatingType}
              <div>
                <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-title">Name</label>
                <input
                  id="task-title"
                  type="text"
                  bind:value={createTitle}
                  placeholder="e.g. Daily report"
                  class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 placeholder:text-text-placeholder"
                />
              </div>
            {/if}

            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-space">Target Space</label>
              <select
                id="task-space"
                bind:value={createSpaceId}
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 text-text-primary"
              >
                <option value="">— Select —</option>
                {#each spaces as space (space.id)}
                  <option value={space.id}>{space.name || space.id.slice(0, 12)}</option>
                {/each}
              </select>
            </div>

            {#if isRepeatingType}
              <div>
                <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-expression">Cron Expression</label>
                <input
                  id="task-expression"
                  type="text"
                  bind:value={createCronExpression}
                  placeholder="e.g. 0 10 * * * (daily at 10AM)"
                  class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] font-mono outline-none focus:border-brand/50 placeholder:text-text-placeholder"
                />
                <p class="mt-1 text-[11px] text-text-placeholder">
                  Format: min hour day month weekday · Example: */30 * * * * (every 30 min)
                </p>
              </div>
            {:else}
              <div>
                <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-schedule">Schedule At</label>
                <input
                  id="task-schedule"
                  type="datetime-local"
                  bind:value={createScheduleAt}
                  class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 text-text-primary"
                />
                <p class="mt-1 text-[11px] text-text-placeholder">
                  Local time (UTC{new Date().getTimezoneOffset() > 0 ? '-' : '+'}{Math.abs(new Date().getTimezoneOffset() / 60)})
                </p>
              </div>
            {/if}

            <div>
              <label class="block text-[12px] font-medium text-text-secondary mb-1" for="task-prompt">Prompt Message</label>
              <textarea
                id="task-prompt"
                bind:value={createPromptText}
                rows="2"
                placeholder="Message content to send to the space..."
                class="w-full px-3 py-2 rounded-md border border-border-subtle bg-bg-secondary text-[13px] outline-none focus:border-brand/50 placeholder:text-text-placeholder resize-none"
              ></textarea>
            </div>
          </div>
        {/if}

        {#if createError}
          <p class="text-[12px] text-error-soft">{createError}</p>
        {/if}
      </div>

      <div class="flex justify-end gap-2 px-4 py-2.5 border-t border-border-subtle">
        <button
          type="button"
          class="px-3 py-1.5 rounded text-[12px] text-text-tertiary hover:text-text-primary transition-colors"
          onclick={closeCreateModal}
          disabled={isCreating}
        >
          Cancel
        </button>
        {#if isEditMode}
          <button
            type="button"
            class="px-3 py-1.5 rounded text-[12px] font-medium bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 flex items-center gap-1.5"
            disabled={isCreating || !createPromptText.trim() || !createSpaceId || !createTitle.trim() || !createCronExpression.trim()}
            onclick={handleCreate}
          >
            {#if isCreating}Updating...{:else}Update{/if}
          </button>
        {:else if isRepeatingType}
          <button
            type="button"
            class="px-3 py-1.5 rounded text-[12px] font-medium bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 flex items-center gap-1.5"
            disabled={isCreating || !createPromptText.trim() || !createSpaceId || !createTitle.trim() || !createCronExpression.trim()}
            onclick={handleCreate}
          >
            {#if isCreating}Creating...{:else}Create{/if}
          </button>
        {:else}
          <button
            type="button"
            class="px-3 py-1.5 rounded text-[12px] font-medium bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 flex items-center gap-1.5"
            disabled={isCreating || !createPromptText.trim() || !createSpaceId || !createScheduleAt}
            onclick={handleCreate}
          >
            {#if isCreating}Creating...{:else}Create{/if}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
