<script lang="ts">
import {
	Bookmark,
	Bot,
	GitFork,
	LayoutGrid,
	MessageSquare,
	SquareStack,
} from "lucide-svelte";

/** Mental-model glossary. Static content only. */
const concepts = [
	{
		icon: SquareStack,
		title: "Space",
		body: "A live, isolated environment holding conversations, files, drafts, and outputs — where people and agents work together.",
	},
	{
		icon: Bookmark,
		title: "Checkpoint",
		body: "An immutable snapshot saved from a Space. Preserve a meaningful moment; share, fork, or restore it later.",
	},
	{
		icon: GitFork,
		title: "Fork",
		body: "Branch a checkpoint into a brand-new Space, fully loaded with its files and state. Never start from zero.",
	},
	{
		icon: LayoutGrid,
		title: "Works",
		body: "Publish files, a directory site, or a running port as a shareable Work — public on the web, no login needed.",
	},
	{
		icon: Bot,
		title: "Agent",
		body: "The active collaborator inside a Space. It reasons, calls tools, edits files, and generates media alongside you.",
	},
	{
		icon: MessageSquare,
		title: "Channel",
		body: "An external entry point — Discord, Telegram, Feishu, WeChat — connected straight to a Space, both ways.",
	},
];
</script>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each concepts as concept (concept.title)}
		<div class="concept">
			<span class="ic">
				<concept.icon class="h-[18px] w-[18px]" />
			</span>
			<h3 class="mt-3.5 text-[15px] font-semibold text-text-primary">{concept.title}</h3>
			<p class="mt-1.5 text-[13px] leading-6 text-text-tertiary">{concept.body}</p>
		</div>
	{/each}
</div>

<style>
	.concept {
		border-radius: 14px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-surface) 40%, transparent);
		padding: 20px;
		transition:
			border-color 0.2s,
			transform 0.2s,
			background 0.2s;
	}
	.concept:hover {
		transform: translateY(-3px);
		border-color: var(--brand-border);
		background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
	}
	.ic {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 10px;
		border: 1px solid var(--brand-border);
		background: var(--brand-muted);
		color: var(--brand);
	}
	@media (prefers-reduced-motion: reduce) {
		.concept:hover {
			transform: none;
		}
	}
</style>
