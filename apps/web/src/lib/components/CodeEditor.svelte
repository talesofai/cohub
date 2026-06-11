<script lang="ts">
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	HighlightStyle,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { onDestroy, onMount } from "svelte";
import {
	isDarkTheme,
	isResolvedTheme,
	type ResolvedTheme,
} from "$lib/theme-registry";

const {
	value = "",
	language = "plaintext",
	readonly = false,
	onInput,
}: {
	value: string;
	language?: string;
	readonly?: boolean;
	onInput?: (v: string) => void;
} = $props();

let container: HTMLDivElement | undefined = $state();
let view: EditorView | undefined = $state();

// Compartments for dynamic reconfiguration
const langConf = new Compartment();
const themeConf = new Compartment();
const readOnlyConf = new Compartment();
let languageLoadId = 0;

async function getLanguageExtension(lang: string): Promise<Extension> {
	const l = lang.toLowerCase();
	const map: Record<string, () => Promise<Extension>> = {
		js: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: false,
			}),
		javascript: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: false,
			}),
		ts: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: false,
			}),
		typescript: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: false,
			}),
		jsx: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: true,
			}),
		tsx: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: true,
			}),
		py: async () => (await import("@codemirror/lang-python")).python(),
		python: async () => (await import("@codemirror/lang-python")).python(),
		json: async () => (await import("@codemirror/lang-json")).json(),
		jsonc: async () => (await import("@codemirror/lang-json")).json(),
		html: async () => (await import("@codemirror/lang-html")).html(),
		htm: async () => (await import("@codemirror/lang-html")).html(),
		svelte: async () => (await import("@codemirror/lang-html")).html(),
		css: async () => (await import("@codemirror/lang-css")).css(),
		scss: async () => (await import("@codemirror/lang-css")).css(),
		md: async () => (await import("@codemirror/lang-markdown")).markdown(),
		markdown: async () =>
			(await import("@codemirror/lang-markdown")).markdown(),
		yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
		yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
		xml: async () => (await import("@codemirror/lang-xml")).xml(),
		svg: async () => (await import("@codemirror/lang-xml")).xml(),
	};
	return (await map[l]?.()) ?? [];
}

async function reconfigureLanguage(lang: string) {
	if (!view) return;
	const loadId = ++languageLoadId;
	const extension = await getLanguageExtension(lang);
	if (!view || loadId !== languageLoadId) return;
	view.dispatch({
		effects: langConf.reconfigure(extension),
	});
}

function isMobile(): boolean {
	if (typeof window === "undefined") return false;
	return window.innerWidth < 640;
}

type EditorPalette = {
	background: string;
	foreground: string;
	muted: string;
	selection: string;
	activeLine: string;
	keyword: string;
	atom: string;
	string: string;
	definition: string;
	variable: string;
	comment: string;
	invalid: string;
};

const EDITOR_PALETTES: Record<ResolvedTheme, EditorPalette> = {
	dark: {
		background: "var(--bg-code)",
		foreground: "var(--text-reading)",
		muted: "var(--text-tertiary)",
		selection: "color-mix(in srgb, var(--brand) 24%, transparent)",
		activeLine: "color-mix(in srgb, var(--bg-hover-strong) 42%, transparent)",
		keyword: "oklch(76% 0.12 300)",
		atom: "oklch(76% 0.14 70)",
		string: "oklch(76% 0.11 155)",
		definition: "oklch(75% 0.1 230)",
		variable: "var(--text-reading)",
		comment: "var(--text-placeholder)",
		invalid: "var(--error-400)",
	},
	light: {
		background: "var(--bg-code)",
		foreground: "var(--text-reading)",
		muted: "var(--text-tertiary)",
		selection: "color-mix(in srgb, var(--brand) 16%, transparent)",
		activeLine: "color-mix(in srgb, var(--bg-hover-strong) 50%, transparent)",
		keyword: "oklch(44% 0.15 300)",
		atom: "oklch(45% 0.14 65)",
		string: "oklch(42% 0.12 150)",
		definition: "oklch(45% 0.13 235)",
		variable: "var(--text-reading)",
		comment: "var(--text-placeholder)",
		invalid: "var(--error-500)",
	},
	"solarized-dark": {
		background: "#002b36",
		foreground: "#93a1a1",
		muted: "#586e75",
		selection: "#073642",
		activeLine: "color-mix(in srgb, #073642 72%, transparent)",
		keyword: "#6c71c4",
		atom: "#b58900",
		string: "#2aa198",
		definition: "#268bd2",
		variable: "#93a1a1",
		comment: "#586e75",
		invalid: "#dc322f",
	},
	"solarized-light": {
		background: "#fdf6e3",
		foreground: "#657b83",
		muted: "#93a1a1",
		selection: "#eee8d5",
		activeLine: "color-mix(in srgb, #eee8d5 76%, transparent)",
		keyword: "#6c71c4",
		atom: "#b58900",
		string: "#2aa198",
		definition: "#268bd2",
		variable: "#657b83",
		comment: "#93a1a1",
		invalid: "#dc322f",
	},
};

function getThemeExtension(theme: ResolvedTheme): Extension {
	const palette = EDITOR_PALETTES[theme];
	const dark = isDarkTheme(theme);

	return [
		EditorView.theme(
			{
				"&": {
					backgroundColor: palette.background,
					color: palette.foreground,
					fontSize: getEditorFont(),
					fontFamily: "var(--font-mono, monospace)",
				},
				"&.cm-focused": {
					outline: "none",
				},
				".cm-scroller": {
					overflow: "auto",
				},
				".cm-gutters": {
					backgroundColor: "transparent",
					borderRight: "1px solid var(--border-subtle)",
					color: palette.muted,
				},
				".cm-activeLineGutter": {
					backgroundColor: "transparent",
					color: palette.foreground,
				},
				".cm-content": {
					padding: "12px 0",
					caretColor: "var(--brand)",
				},
				".cm-line": {
					padding: "0 8px",
				},
				".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
					backgroundColor: palette.selection,
				},
				".cm-activeLine": {
					backgroundColor: palette.activeLine,
				},
				".cm-cursor": {
					borderLeftColor: "var(--brand)",
				},
			},
			{ dark },
		),
		syntaxHighlighting(
			HighlightStyle.define([
				{ tag: t.keyword, color: palette.keyword },
				{
					tag: [t.atom, t.bool, t.number, t.constant(t.variableName)],
					color: palette.atom,
				},
				{
					tag: [t.string, t.special(t.string), t.regexp],
					color: palette.string,
				},
				{
					tag: [
						t.definition(t.variableName),
						t.definition(t.function(t.variableName)),
					],
					color: palette.definition,
				},
				{
					tag: [t.variableName, t.propertyName, t.attributeName],
					color: palette.variable,
				},
				{
					tag: [t.comment, t.lineComment, t.blockComment],
					color: palette.comment,
					fontStyle: "italic",
				},
				{
					tag: [t.heading, t.strong],
					color: palette.foreground,
					fontWeight: "600",
				},
				{
					tag: [t.link, t.url],
					color: palette.definition,
					textDecoration: "underline",
				},
				{ tag: t.invalid, color: palette.invalid },
			]),
		),
	];
}

function getEditorFont(): string {
	return isMobile() ? "15px" : "13px";
}

function resolveTheme(): ResolvedTheme {
	if (typeof document === "undefined") return "dark";
	const attr = document.documentElement.getAttribute("data-theme");
	return isResolvedTheme(attr) ? attr : "dark";
}

function reconfigureTheme(theme = resolveTheme()) {
	if (!view || theme === currentTheme) return;
	currentTheme = theme;
	view.dispatch({
		effects: themeConf.reconfigure(getThemeExtension(theme)),
	});
}

let currentLanguage = $derived(language);
let currentTheme = $state(resolveTheme());

$effect(() => {
	if (!view) return;
	void reconfigureLanguage(currentLanguage);
});

$effect(() => {
	if (!view) return;
	reconfigureTheme();
});

$effect(() => {
	if (!view) return;
	view.dispatch({
		effects: readOnlyConf.reconfigure([
			EditorView.editable.of(!readonly),
			EditorState.readOnly.of(readonly),
		]),
	});
});

// Sync external value changes into the editor (but not while typing)
let syncing = $state(false);
let lastExternal = $state("");

$effect(() => {
	const v = value;
	if (syncing || !view || v === lastExternal) return;
	lastExternal = v;
	const current = view.state.doc.toString();
	if (v !== current) {
		view.dispatch({
			changes: { from: 0, to: current.length, insert: v },
			selection: { anchor: 0 },
		});
	}
});

onMount(() => {
	if (!container) return;

	const theme = resolveTheme();
	currentTheme = theme;
	lastExternal = value;
	syncing = true;

	view = new EditorView({
		state: EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				foldGutter(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...foldKeymap,
					indentWithTab,
				]),
				langConf.of([]),
				themeConf.of(getThemeExtension(theme)),
				readOnlyConf.of([
					EditorView.editable.of(!readonly),
					EditorState.readOnly.of(readonly),
				]),
				EditorView.lineWrapping,
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						syncing = false;
						lastExternal = update.state.doc.toString();
						onInput?.(lastExternal);
					}
				}),
			],
		}),
		parent: container,
	});
	void reconfigureLanguage(language);

	const themeObserver = new MutationObserver(() => reconfigureTheme());
	themeObserver.observe(document.documentElement, {
		attributeFilter: ["data-theme"],
	});

	syncing = false;

	return () => {
		themeObserver.disconnect();
	};
});

onDestroy(() => {
	view?.destroy();
	view = undefined;
});
</script>

<!--
  data-drawer-swipe-ignore: prevents the mobile drawer gesture system
  from intercepting touches inside the editor (gutters, scroll areas, etc.).
  touch-action: pan-x pan-y: overrides the inherited pan-y from
  .mobile-drawer-gesture-surface so CodeMirror can handle horizontal
  scrolling for long lines on mobile.
-->
<div bind:this={container} class="cm-wrapper" data-drawer-swipe-ignore></div>

<style>
  .cm-wrapper {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    touch-action: pan-x pan-y;
  }
  .cm-wrapper :global(.cm-editor) {
    height: 100%;
  }
  .cm-wrapper :global(.cm-scroller) {
    font-family: var(--font-mono, monospace);
  }
</style>
