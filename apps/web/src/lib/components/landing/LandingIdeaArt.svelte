<script lang="ts">
/**
 * Per-idea decorative micro-animation. Pure CSS/SVG, no images or data.
 * `kind` selects one of the five choreographies matching the five ideas.
 */
type Kind = "spark" | "build" | "open" | "work" | "fork";
const { kind }: { kind: Kind } = $props();
</script>

<div class="art art-{kind}">
	{#if kind === "spark"}
		<div class="prompt">
			draw a tiny robot watering a plant<span class="caret"></span>
		</div>
		<div class="shapes"><b></b><b></b><b></b><b></b></div>
	{:else if kind === "build"}
		<div class="avs"><span>A</span><span>M</span><span>C</span></div>
		<div class="flow">
			<div class="row"><span class="tagm p">you</span><span class="bar" style="max-width:70%"></span></div>
			<div class="row"><span class="tagm a">agent</span><span class="tool">✎ edit settings.tsx</span></div>
			<div class="row"><span class="tagm p">mia</span><span class="bar" style="max-width:55%"></span></div>
			<div class="row"><span class="tagm a">agent</span><span class="bar" style="max-width:85%"></span></div>
		</div>
	{:else if kind === "open"}
		<div class="ring ring1"></div>
		<div class="ring ring2"></div>
		<div class="core">C</div>
		<span class="sat sat1" title="Discord">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4a19 19 0 0 0-4.9-1.5l-.2.5A17 17 0 0 1 12 3c-.8 0-1.6.1-2 .1l-.2-.5A19 19 0 0 0 4 4 20 20 0 0 0 1 18a19 19 0 0 0 5.7 2l.5-1.1a12 12 0 0 1-1.9-.9l.4-.3a13 13 0 0 0 12.6 0l.4.3a12 12 0 0 1-1.9.9L18 20a19 19 0 0 0 5.7-2A20 20 0 0 0 20 4M9 14c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2m6 0c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2" /></svg>
		</span>
		<span class="sat sat2" title="WeChat">微</span>
		<span class="sat sat3" title="Feishu">飞</span>
		<span class="sat sat4" title="CLI">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8" /></svg>
		</span>
	{:else if kind === "work"}
		<div class="browser">
			<div class="bbar"><i></i><i></i><i></i><span class="url">cohub.run/you/space/w/mini-game</span></div>
			<div class="view">
				<div class="app">
					<div class="t"></div>
					<div class="btnrow"><span class="b b1"></span><span class="b b2"></span></div>
				</div>
				<span class="publish"><span class="pdot"></span> published</span>
			</div>
		</div>
	{:else if kind === "fork"}
		<svg class="graph" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet">
			<path class="edge" d="M40 90 H120" />
			<path class="edge" d="M120 90 H210" />
			<path class="edge eb" d="M120 90 C160 90 160 40 210 40" />
			<path class="edge eb" d="M120 90 C160 90 160 140 210 140" />
			<circle class="node" cx="40" cy="90" r="10" />
			<circle class="node" cx="120" cy="90" r="10" />
			<circle class="node nb" cx="210" cy="40" r="10" />
			<circle class="node" cx="210" cy="90" r="10" />
			<circle class="node nb" cx="210" cy="140" r="10" />
		</svg>
		<div class="mention">reference <span class="at">@northlands</span> and build a variant</div>
	{/if}
</div>

<style>
	.art {
		position: relative;
		overflow: hidden;
		aspect-ratio: 16 / 11;
		border-radius: 18px;
		border: 1px solid var(--border-subtle);
		background: linear-gradient(180deg, var(--bg-content), var(--bg-surface));
		box-shadow: 0 30px 70px -50px rgba(0, 0, 0, 0.9);
	}
	.art::after {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(90% 90% at 50% 0%, color-mix(in srgb, var(--brand) 6%, transparent), transparent 60%);
	}

	/* ---- spark ---- */
	.art-spark {
		display: grid;
		place-items: center;
	}
	.prompt {
		position: absolute;
		top: 16px;
		left: 16px;
		right: 16px;
		display: flex;
		align-items: center;
		gap: 8px;
		border-radius: 999px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-primary) 60%, transparent);
		padding: 8px 12px;
		font-size: 12px;
		color: var(--text-tertiary);
	}
	.caret {
		width: 6px;
		height: 14px;
		border-radius: 2px;
		background: var(--brand);
		animation: blink 1s step-end infinite;
	}
	.shapes b {
		position: absolute;
		border-radius: 8px;
		opacity: 0;
		animation: pop 4s ease-in-out infinite;
	}
	.shapes b:nth-child(1) {
		left: 26%;
		top: 52%;
		width: 46px;
		height: 46px;
		border-radius: 14px;
		background: var(--brand);
		animation-delay: 0.3s;
	}
	.shapes b:nth-child(2) {
		left: 52%;
		top: 40%;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--brand) 55%, var(--bg-elevated));
		animation-delay: 1.1s;
	}
	.shapes b:nth-child(3) {
		left: 60%;
		top: 60%;
		width: 54px;
		height: 34px;
		border: 1px solid var(--brand-border);
		background: var(--bg-elevated);
		animation-delay: 1.8s;
	}
	.shapes b:nth-child(4) {
		left: 40%;
		top: 66%;
		width: 22px;
		height: 22px;
		transform: rotate(45deg);
		background: var(--brand-300);
		animation-delay: 2.5s;
	}

	/* ---- build ---- */
	.avs {
		position: absolute;
		top: 18px;
		left: 18px;
		display: flex;
	}
	.avs span {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		margin-left: -8px;
		border-radius: 50%;
		border: 2px solid var(--bg-content);
		font-size: 11px;
		font-weight: 600;
		color: var(--brand-contrast-fg);
	}
	.avs span:nth-child(1) {
		margin-left: 0;
		background: oklch(62% 0.15 20);
	}
	.avs span:nth-child(2) {
		background: oklch(60% 0.13 250);
	}
	.avs span:nth-child(3) {
		background: var(--brand);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 20%, transparent);
	}
	.flow {
		position: absolute;
		inset: 62px 18px 18px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		opacity: 0;
		animation: appear 0.4s ease forwards;
	}
	.row:nth-child(1) {
		animation-delay: 0.3s;
	}
	.row:nth-child(2) {
		animation-delay: 1.3s;
	}
	.row:nth-child(3) {
		animation-delay: 2.3s;
	}
	.row:nth-child(4) {
		animation-delay: 3.3s;
	}
	.tagm {
		flex: none;
		border-radius: 999px;
		padding: 2px 7px;
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.tagm.p {
		background: color-mix(in srgb, oklch(62% 0.15 20) 22%, transparent);
		color: oklch(78% 0.1 20);
	}
	.tagm.a {
		border: 1px solid var(--brand-border);
		background: var(--brand-muted);
		color: var(--brand);
	}
	.bar {
		flex: 1;
		height: 9px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-tertiary) 22%, transparent);
	}
	.tool {
		border-radius: 8px;
		border: 1px dashed var(--brand-border);
		background: var(--brand-muted);
		padding: 4px 8px;
		font-size: 11px;
		color: var(--text-tertiary);
	}

	/* ---- open ---- */
	.art-open {
		display: grid;
		place-items: center;
	}
	.core {
		z-index: 2;
		display: grid;
		place-items: center;
		width: 62px;
		height: 62px;
		border-radius: 18px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		font-weight: 700;
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--brand) 40%, transparent),
			0 0 50px -6px var(--brand);
	}
	.ring {
		position: absolute;
		border: 1px dashed var(--border-primary);
		border-radius: 50%;
	}
	.ring1 {
		width: 190px;
		height: 190px;
		animation: spin 26s linear infinite;
	}
	.ring2 {
		width: 280px;
		height: 280px;
		animation: spin 40s linear infinite reverse;
	}
	.sat {
		position: absolute;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 10px;
		font-weight: 600;
	}
	.sat :global(svg) {
		width: 17px;
		height: 17px;
	}
	.sat1 {
		top: calc(50% - 95px);
		left: calc(50% - 17px);
		color: var(--provider-discord);
		animation: chpulse 4s infinite;
	}
	.sat2 {
		top: calc(50% - 17px);
		left: calc(50% + 78px);
		color: var(--provider-wechat);
		animation: chpulse 4s infinite 1s;
	}
	.sat3 {
		top: calc(50% + 78px);
		left: calc(50% - 17px);
		color: var(--provider-feishu);
		animation: chpulse 4s infinite 2s;
	}
	.sat4 {
		top: calc(50% - 17px);
		left: calc(50% - 112px);
		color: var(--text-secondary);
		animation: chpulse 4s infinite 3s;
	}

	/* ---- work ---- */
	.browser {
		position: absolute;
		inset: 18px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: 12px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-primary);
	}
	.bbar {
		display: flex;
		align-items: center;
		gap: 6px;
		border-bottom: 1px solid var(--border-subtle);
		padding: 8px 10px;
	}
	.bbar i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--bg-elevated);
	}
	.url {
		margin-left: 8px;
		border-radius: 6px;
		background: var(--bg-surface);
		padding: 3px 8px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--text-tertiary);
	}
	.view {
		position: relative;
		flex: 1;
		display: grid;
		place-items: center;
		background: radial-gradient(70% 90% at 50% 20%, color-mix(in srgb, var(--brand) 12%, transparent), transparent 60%);
	}
	.app {
		width: 60%;
	}
	.app .t {
		height: 12px;
		width: 55%;
		margin: 0 auto 12px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--text-secondary) 40%, transparent);
	}
	.btnrow {
		display: flex;
		justify-content: center;
		gap: 8px;
	}
	.b {
		height: 26px;
		border-radius: 8px;
	}
	.b1 {
		width: 74px;
		background: var(--brand);
		animation: press 3s ease-in-out infinite;
	}
	.b2 {
		width: 58px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
	}
	.publish {
		position: absolute;
		right: 12px;
		bottom: 12px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border-radius: 999px;
		border: 1px solid var(--brand-border);
		background: var(--brand-muted);
		padding: 4px 10px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--brand);
		animation: bob 5s ease-in-out infinite;
	}
	.pdot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brand);
		animation: pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	/* ---- fork ---- */
	.art-fork {
		padding: 22px;
	}
	.graph {
		width: 100%;
		height: 100%;
	}
	.node {
		fill: var(--bg-elevated);
		stroke: var(--border-primary);
	}
	.node.nb {
		fill: var(--brand);
		stroke: none;
	}
	.edge {
		fill: none;
		stroke: var(--border-primary);
		stroke-width: 2;
	}
	.edge.eb {
		stroke: var(--brand);
		stroke-dasharray: 6 6;
		animation: dash 1.2s linear infinite;
	}
	.mention {
		position: absolute;
		left: 22px;
		bottom: 22px;
		right: 22px;
		display: flex;
		align-items: center;
		gap: 8px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-primary) 60%, transparent);
		padding: 8px 10px;
		font-size: 12px;
		color: var(--text-tertiary);
	}
	.at {
		border-radius: 5px;
		background: var(--brand-muted);
		padding: 1px 6px;
		font-family: var(--font-mono);
		color: var(--brand);
	}

	@keyframes pop {
		0% {
			opacity: 0;
			transform: scale(0.4) translateY(8px);
		}
		18% {
			opacity: 1;
			transform: scale(1);
		}
		82% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: scale(0.9) translateY(-6px);
		}
	}
	@keyframes appear {
		to {
			opacity: 1;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes chpulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
			border-color: var(--border-subtle);
		}
		50% {
			box-shadow: 0 0 22px -4px currentColor;
			border-color: currentColor;
		}
	}
	@keyframes press {
		0%,
		100% {
			transform: none;
		}
		50% {
			transform: scale(0.94);
			filter: brightness(1.15);
		}
	}
	@keyframes dash {
		to {
			stroke-dashoffset: -24;
		}
	}
	@keyframes blink {
		50% {
			opacity: 0.2;
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

	@media (prefers-reduced-motion: reduce) {
		.art :global(*) {
			animation: none !important;
		}
		.row {
			opacity: 1 !important;
		}
		.shapes b {
			opacity: 1 !important;
			transform: none !important;
		}
	}
</style>
