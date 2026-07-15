<script lang="ts">
import { Bookmark, Clock, LayoutGrid, MessageSquare } from "lucide-svelte";
import { onMount } from "svelte";

/**
 * Hero "living Space" visual — a self-playing product micro-demo built
 * entirely from CSS/SVG. No images, no video, no data. A teammate drops a
 * request, you hand it to the agent, and the agent streams a reply while a
 * generated music tile plays — showing people and agents co-creating in one
 * Space across more than one medium.
 *
 * The conversation is keyed on `cycle`; bumping it remounts the sequence so
 * the choreography loops. Looping is skipped under reduced-motion.
 */
let cycle = $state(0);

onMount(() => {
	if (
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		return;
	}
	const id = setInterval(() => {
		cycle += 1;
	}, 9000);
	return () => clearInterval(id);
});
</script>

<div class="relative">
	<!-- Floating status chips -->
	<div class="chip chip-save">
		<span class="cdot" style="background:var(--brand)"></span> checkpoint saved
	</div>
	<div class="chip chip-fork">
		<span class="cdot" style="background:var(--provider-feishu)"></span> forked → new space
	</div>

	<div class="stage" aria-hidden="true">
		<div class="mb-3.5 flex items-center gap-2 px-1 pt-0.5">
			<span class="tl"></span>
			<span class="tl"></span>
			<span class="tl tl-g"></span>
			<span class="ml-1.5 font-mono text-[12px] text-text-tertiary">game-jam · 3 online</span>
			<span class="ml-auto inline-flex items-center gap-1.5 text-[11px] text-brand">
				<span class="live-dot h-1.5 w-1.5 rounded-full bg-brand"></span> live
			</span>
		</div>

		<div class="grid grid-cols-[44px_1fr] gap-3">
			<!-- rail -->
			<div class="flex flex-col gap-2 pt-0.5">
				<i class="rail-i rail-on" title="Chats"><MessageSquare /></i>
				<i class="rail-i" title="Saves"><Bookmark /></i>
				<i class="rail-i" title="Works"><LayoutGrid /></i>
				<i class="rail-i" title="Scheduled"><Clock /></i>
			</div>

			<!-- conversation -->
			{#key cycle}
				<div class="convo">
					<div class="msg msg-mia">
						<span class="av av-mia">M</span>
						<span class="bubble bubble-peer">the boss needs a theme song</span>
					</div>

					<div class="msg msg-u1">
						<span class="av av-user">You</span>
						<span class="bubble bubble-user"><span class="typed">@agent make one, ~30s loop</span></span>
					</div>

					<div class="msg msg-a1">
						<span class="av av-agent">C</span>
						<span class="think">thinking <b></b><b></b><b></b></span>
					</div>

					<div class="msg msg-a2">
						<span class="av av-agent invisible">C</span>
						<span class="bubble w-full text-text-secondary">
							<span class="stream-line w95"></span>
							<span class="stream-line w60"></span>
							<div class="gen">
								<span class="gen-badge">music · 0:30 loop</span>
								<div class="wave">
									<b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b>
								</div>
								<span class="gen-shimmer"></span>
							</div>
						</span>
					</div>

					<div class="tray">
						<span class="spin"></span> generating music
						<span class="tray-running">running 1</span>
						<span class="tray-done">✓ done</span>
					</div>
				</div>
			{/key}
		</div>
	</div>
</div>

<style>
	.stage {
		position: relative;
		overflow: hidden;
		border-radius: 20px;
		border: 1px solid var(--border-subtle);
		padding: 18px;
		background:
			radial-gradient(120% 100% at 30% 0%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 55%),
			linear-gradient(180deg, var(--bg-content), var(--bg-surface));
		box-shadow:
			0 40px 90px -50px rgba(0, 0, 0, 0.9),
			inset 0 1px 0 color-mix(in srgb, white 4%, transparent);
	}
	.stage::before {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(circle at 50% 120%, color-mix(in srgb, var(--brand) 10%, transparent), transparent 60%);
	}

	.tl {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		background: var(--bg-elevated);
	}
	.tl-g {
		background: color-mix(in srgb, var(--brand) 70%, var(--bg-elevated));
	}

	.rail-i {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 11px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
		color: var(--text-tertiary);
	}
	.rail-i.rail-on {
		color: var(--brand);
		border-color: var(--brand-border);
		background: var(--brand-muted);
	}
	.rail-i :global(svg) {
		width: 18px;
		height: 18px;
	}

	.convo {
		display: flex;
		min-height: 340px;
		flex-direction: column;
		gap: 12px;
		border-radius: 14px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-primary) 55%, transparent);
		padding: 14px;
	}

	.msg {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.av {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: 8px;
		font-size: 11px;
		font-weight: 600;
	}
	.av-user {
		background: color-mix(in srgb, var(--brand) 20%, var(--bg-surface));
		color: var(--text-primary);
	}
	.av-mia {
		background: oklch(60% 0.13 250);
		color: var(--brand-contrast-fg);
	}
	.av-agent {
		background: var(--brand);
		color: var(--brand-contrast-fg);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 18%, transparent);
	}
	.bubble {
		border-radius: 12px;
		padding: 9px 12px;
		font-size: 13px;
		max-width: 88%;
	}
	.bubble-user {
		background: color-mix(in srgb, var(--brand) 8%, transparent);
		border: 1px solid var(--brand-border);
	}
	.bubble-peer {
		background: color-mix(in srgb, var(--bg-surface) 70%, transparent);
		border: 1px solid var(--border-subtle);
		color: var(--text-secondary);
	}

	.typed {
		display: inline-block;
		overflow: hidden;
		white-space: nowrap;
		border-right: 2px solid var(--brand);
	}

	.think {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--text-placeholder);
	}
	.think b {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-placeholder);
		animation: blink 1.2s infinite;
	}
	.think b:nth-child(2) {
		animation-delay: 0.2s;
	}
	.think b:nth-child(3) {
		animation-delay: 0.4s;
	}

	.stream-line {
		display: block;
		height: 8px;
		margin: 6px 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-tertiary) 30%, transparent);
		opacity: 0;
	}
	.stream-line.w95 {
		max-width: 95%;
	}
	.stream-line.w60 {
		max-width: 60%;
	}

	.gen {
		position: relative;
		margin-top: 2px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: 12px;
		border: 1px solid var(--brand-border);
		aspect-ratio: 16 / 9;
		opacity: 0;
		transform: translateY(8px) scale(0.98);
		background:
			radial-gradient(80% 120% at 30% 10%, color-mix(in srgb, var(--brand) 22%, transparent), transparent 60%),
			linear-gradient(135deg, var(--brand-bg), var(--bg-surface));
		animation: gen-in 0.7s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
		animation-delay: 5s;
	}
	.gen-badge {
		position: absolute;
		left: 10px;
		top: 9px;
		border-radius: 999px;
		border: 1px solid var(--border-subtle);
		padding: 3px 8px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
		backdrop-filter: blur(4px);
	}
	/* music waveform */
	.wave {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: 46px;
		padding-inline: 12px;
	}
	.wave b {
		width: 3px;
		height: 20%;
		border-radius: 999px;
		background: color-mix(in srgb, var(--brand) 85%, white 5%);
		transform-origin: center;
		animation: eq 1.1s ease-in-out infinite;
		animation-delay: 5.2s;
	}
	.wave b:nth-child(3n) {
		animation-duration: 0.9s;
	}
	.wave b:nth-child(4n) {
		animation-duration: 1.3s;
	}
	.wave b:nth-child(2n) {
		background: color-mix(in srgb, var(--brand) 55%, var(--bg-elevated));
	}
	.wave b:nth-child(1) { animation-delay: 5.2s; }
	.wave b:nth-child(2) { animation-delay: 5.28s; }
	.wave b:nth-child(3) { animation-delay: 5.36s; }
	.wave b:nth-child(4) { animation-delay: 5.44s; }
	.wave b:nth-child(5) { animation-delay: 5.52s; }
	.wave b:nth-child(6) { animation-delay: 5.6s; }
	.wave b:nth-child(7) { animation-delay: 5.68s; }
	.wave b:nth-child(8) { animation-delay: 5.76s; }
	.wave b:nth-child(9) { animation-delay: 5.84s; }
	.wave b:nth-child(10) { animation-delay: 5.92s; }
	.wave b:nth-child(11) { animation-delay: 6s; }
	.wave b:nth-child(12) { animation-delay: 6.08s; }
	.wave b:nth-child(13) { animation-delay: 6.16s; }
	.wave b:nth-child(14) { animation-delay: 6.24s; }
	.wave b:nth-child(15) { animation-delay: 6.32s; }
	.wave b:nth-child(16) { animation-delay: 6.4s; }
	.wave b:nth-child(17) { animation-delay: 6.48s; }
	.wave b:nth-child(18) { animation-delay: 6.56s; }
	.gen-shimmer {
		position: absolute;
		inset: 0;
		transform: translateX(-100%);
		background: linear-gradient(105deg, transparent 30%, color-mix(in srgb, white 10%, transparent) 48%, transparent 66%);
		animation: shimmer 2.6s ease-in-out infinite;
		animation-delay: 5.5s;
	}

	.tray {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: auto;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-surface) 55%, transparent);
		padding: 9px 11px;
		font-size: 12px;
		color: var(--text-tertiary);
		opacity: 0;
		animation: appear 0.3s ease forwards;
		animation-delay: 4.3s;
	}
	.spin {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 2px solid var(--border-primary);
		border-top-color: var(--brand);
		animation: sp 0.8s linear infinite;
	}
	.tray-running {
		margin-left: auto;
		animation: fade-out 0.3s ease forwards;
		animation-delay: 5.6s;
	}
	.tray-done {
		margin-left: auto;
		color: var(--brand);
		opacity: 0;
		animation: appear 0.3s ease forwards;
		animation-delay: 5.7s;
	}

	/* choreography */
	.msg-mia {
		opacity: 0;
		animation: appear 0.4s ease forwards;
		animation-delay: 0.4s;
	}
	.msg-u1 {
		opacity: 0;
		animation: appear 0.01s linear forwards;
		animation-delay: 1.2s;
	}
	.msg-u1 .typed {
		width: 0;
		animation:
			type 1.5s steps(26) forwards,
			caret 0.7s step-end 6;
		animation-delay: 1.4s, 1.4s;
	}
	.msg-a1 {
		opacity: 0;
		animation: appear 0.3s ease forwards;
		animation-delay: 3.3s;
	}
	.msg-a2 {
		opacity: 0;
		animation: appear 0.3s ease forwards;
		animation-delay: 4.2s;
	}
	.msg-a2 .stream-line {
		animation: grow 0.5s ease forwards;
	}
	.msg-a2 .stream-line:nth-child(1) {
		width: 0;
		animation-delay: 4.3s;
	}
	.msg-a2 .stream-line:nth-child(2) {
		width: 0;
		animation-delay: 4.55s;
	}

	.live-dot {
		animation: pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	/* floating chips */
	.chip {
		position: absolute;
		z-index: 3;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 60%, var(--bg-primary));
		padding: 6px 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
		box-shadow: 0 12px 30px -14px rgba(0, 0, 0, 0.8);
		backdrop-filter: blur(6px);
		animation: bob 6s ease-in-out infinite;
	}
	.cdot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
	.chip-save {
		top: 8%;
		right: -10px;
		animation-delay: 0.2s;
	}
	.chip-fork {
		bottom: 16%;
		left: -14px;
		animation-delay: 1.4s;
	}
	@media (max-width: 520px) {
		.chip {
			display: none;
		}
	}

	@keyframes type {
		to {
			width: 16.5em;
		}
	}
	@keyframes caret {
		50% {
			border-color: transparent;
		}
	}
	@keyframes appear {
		to {
			opacity: 1;
		}
	}
	@keyframes grow {
		from {
			width: 0;
			opacity: 0.2;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes gen-in {
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes shimmer {
		0% {
			transform: translateX(-100%);
		}
		60%,
		100% {
			transform: translateX(100%);
		}
	}
	@keyframes eq {
		0%,
		100% {
			height: 22%;
		}
		50% {
			height: 90%;
		}
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 0.25;
		}
		50% {
			opacity: 1;
		}
	}
	@keyframes sp {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes fade-out {
		to {
			opacity: 0;
		}
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.35;
			transform: scale(0.7);
		}
	}
	@keyframes bob {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-8px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.stage :global(*),
		.stage :global(*::before),
		.chip {
			animation: none !important;
		}
		.msg-mia,
		.msg-u1,
		.msg-a1,
		.msg-a2,
		.tray,
		.tray-done,
		.gen {
			opacity: 1 !important;
			transform: none !important;
		}
		.tray-running {
			display: none;
		}
		.typed {
			width: 16.5em;
			border-right-color: transparent;
		}
		.stream-line {
			opacity: 1;
		}
		.stream-line.w95 {
			width: 95%;
		}
		.stream-line.w60 {
			width: 60%;
		}
		.wave b {
			height: 55%;
		}
	}
</style>
