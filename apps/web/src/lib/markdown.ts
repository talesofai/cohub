import DOMPurify from "isomorphic-dompurify";
import { marked, type Token, type Tokens } from "marked";
import remend from "remend";
import {
	createHighlighterCore,
	type HighlighterCore,
	type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const MARKDOWN_RENDER_CACHE_LIMIT = 256;
const markdownRenderCache = new Map<string, Promise<string>>();

function cacheMarkdownRender(key: string, render: () => Promise<string>) {
	const cached = markdownRenderCache.get(key);
	if (cached) return cached;

	const promise = render().catch((error) => {
		markdownRenderCache.delete(key);
		throw error;
	});

	markdownRenderCache.set(key, promise);
	if (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
		const firstKey = markdownRenderCache.keys().next().value;
		if (firstKey) markdownRenderCache.delete(firstKey);
	}

	return promise;
}

// Shiki highlighter — singleton, lazily initialized
let highlighterPromise: Promise<HighlighterCore> | null = null;
type ShikiLanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const shikiLanguageLoaders = {
	bash: () => import("@shikijs/langs/bash"),
	c: () => import("@shikijs/langs/c"),
	cpp: () => import("@shikijs/langs/cpp"),
	css: () => import("@shikijs/langs/css"),
	diff: () => import("@shikijs/langs/diff"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	go: () => import("@shikijs/langs/go"),
	graphql: () => import("@shikijs/langs/graphql"),
	html: () => import("@shikijs/langs/html"),
	ini: () => import("@shikijs/langs/ini"),
	java: () => import("@shikijs/langs/java"),
	javascript: () => import("@shikijs/langs/javascript"),
	json: () => import("@shikijs/langs/json"),
	jsx: () => import("@shikijs/langs/jsx"),
	markdown: () => import("@shikijs/langs/markdown"),
	mermaid: () => import("@shikijs/langs/mermaid"),
	protobuf: () => import("@shikijs/langs/protobuf"),
	python: () => import("@shikijs/langs/python"),
	rust: () => import("@shikijs/langs/rust"),
	shellscript: () => import("@shikijs/langs/shellscript"),
	sql: () => import("@shikijs/langs/sql"),
	toml: () => import("@shikijs/langs/toml"),
	tsx: () => import("@shikijs/langs/tsx"),
	typescript: () => import("@shikijs/langs/typescript"),
	xml: () => import("@shikijs/langs/xml"),
	yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<string, ShikiLanguageLoader>;

type SupportedShikiLanguage = keyof typeof shikiLanguageLoaders;

const shikiLanguageAliases = new Map<string, SupportedShikiLanguage>([
	["bash", "bash"],
	["c++", "cpp"],
	["cpp", "cpp"],
	["cxx", "cpp"],
	["c", "c"],
	["css", "css"],
	["diff", "diff"],
	["docker", "dockerfile"],
	["dockerfile", "dockerfile"],
	["go", "go"],
	["golang", "go"],
	["graphql", "graphql"],
	["gql", "graphql"],
	["html", "html"],
	["ini", "ini"],
	["java", "java"],
	["javascript", "javascript"],
	["js", "javascript"],
	["json", "json"],
	["jsx", "jsx"],
	["markdown", "markdown"],
	["md", "markdown"],
	["mdx", "markdown"],
	["mermaid", "mermaid"],
	["proto", "protobuf"],
	["protobuf", "protobuf"],
	["py", "python"],
	["python", "python"],
	["rs", "rust"],
	["rust", "rust"],
	["sh", "shellscript"],
	["shell", "shellscript"],
	["shellscript", "shellscript"],
	["sql", "sql"],
	["toml", "toml"],
	["tsx", "tsx"],
	["ts", "typescript"],
	["typescript", "typescript"],
	["xml", "xml"],
	["yaml", "yaml"],
	["yml", "yaml"],
]);

const loadedShikiLanguages = new Set<SupportedShikiLanguage>();

function normalizeShikiLanguage(rawLang: string) {
	return shikiLanguageAliases.get(rawLang.toLowerCase()) ?? null;
}

function collectCodeTokenLanguages(
	tokens: Token[],
	languages = new Set<SupportedShikiLanguage>(),
) {
	for (const token of tokens) {
		if (token.type === "code" && "lang" in token && token.lang) {
			const rawLang = token.lang.split(" ")[0];
			if (rawLang) {
				const lang = normalizeShikiLanguage(rawLang);
				if (lang) languages.add(lang);
			}
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			collectCodeTokenLanguages(token.tokens, languages);
		}
	}

	return languages;
}

async function createMarkdownHighlighter() {
	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		themes: [
			import("@shikijs/themes/github-light"),
			import("@shikijs/themes/github-dark"),
			import("@shikijs/themes/solarized-light"),
			import("@shikijs/themes/solarized-dark"),
		],
		langs: [],
	});
}

function getHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = createMarkdownHighlighter();
	}
	return highlighterPromise;
}

async function loadShikiLanguages(
	highlighter: HighlighterCore,
	languages: Set<SupportedShikiLanguage>,
) {
	const pending = [...languages].filter(
		(lang) => !loadedShikiLanguages.has(lang),
	);
	if (pending.length === 0) return;

	const modules = await Promise.all(
		pending.map(async (lang) => ({
			lang,
			registration: (await shikiLanguageLoaders[lang]()).default,
		})),
	);

	await highlighter.loadLanguage(
		...modules.map(({ registration }) => registration),
	);
	for (const { lang } of modules) loadedShikiLanguages.add(lang);
}

/**
 * Walk tokens recursively and replace code tokens with html tokens
 * containing shiki-highlighted output.
 *
 * We use `html` tokens (not `code` tokens) because marked.parser
 * escapes code token content, which would break shiki's HTML output.
 */
async function highlightCodeTokens(tokens: Token[]) {
	const highlighter = await getHighlighter();
	await loadShikiLanguages(highlighter, collectCodeTokenLanguages(tokens));

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "code" && "lang" in token && token.lang) {
			const rawLang = token.lang.split(" ")[0]; // handle e.g. "ts {1-3}"
			const lang = rawLang ? normalizeShikiLanguage(rawLang) : null;
			if (!lang) continue;

			try {
				const highlighted = highlighter.codeToHtml(token.text, {
					lang,
					themes: {
						light: "github-light",
						dark: "github-dark",
						"solarized-light": "solarized-light",
						"solarized-dark": "solarized-dark",
					},
					defaultColor: false,
				});

				// Replace code token with html token so marked renders it unescaped
				const codeToken = token as Tokens.Code;
				tokens[i] = {
					type: "html",
					raw: codeToken.raw,
					text: highlighted,
					pre: true,
				} as Tokens.HTML;
			} catch {
				// Fallback: leave code as-is
			}
		}

		// Recurse into nested tokens (lists, blockquotes, etc.)
		if ("tokens" in token && Array.isArray(token.tokens)) {
			await highlightCodeTokens(token.tokens);
		}
	}
}

const AUDIO_EXTENSIONS = new Set([
	"aac",
	"flac",
	"m4a",
	"mp3",
	"oga",
	"ogg",
	"opus",
	"wav",
]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

type MarkdownMediaType = "audio" | "video";

function getMediaTypeFromHref(href: string): MarkdownMediaType | null {
	try {
		const url = new URL(
			href,
			typeof window === "undefined"
				? "https://cohub.local"
				: window.location.href,
		);
		const extension = url.pathname.split(".").pop()?.toLowerCase();
		if (!extension) return null;
		if (AUDIO_EXTENSIONS.has(extension)) return "audio";
		if (VIDEO_EXTENSIONS.has(extension)) return "video";
		return null;
	} catch {
		return null;
	}
}

function renderMediaPreviewHtml(input: {
	href: string;
	title?: string | null;
	label?: string;
	type: MarkdownMediaType;
}) {
	const src = escapeHtml(input.href);
	const title = input.title ? ` title="${escapeHtml(input.title)}"` : "";
	const label = input.label?.trim();
	const caption = label ? `<figcaption>${escapeHtml(label)}</figcaption>` : "";

	if (input.type === "audio") {
		return `<figure class="markdown-media markdown-audio"><audio controls preload="metadata" src="${src}"${title}></audio>${caption}</figure>`;
	}

	const ariaLabel = label ? escapeHtml(label) : "Video preview";
	return `<figure class="markdown-media markdown-video"><video controls playsinline preload="metadata" src="${src}" aria-label="${ariaLabel}"${title}></video>${caption}</figure>`;
}

function getStandaloneMediaToken(token: Token) {
	if (token.type !== "paragraph" || !("tokens" in token)) return null;
	const inlineTokens = token.tokens;
	if (!Array.isArray(inlineTokens) || inlineTokens.length !== 1) return null;

	const inlineToken = inlineTokens[0];
	if (!inlineToken || !("href" in inlineToken)) return null;
	if (inlineToken.type !== "image" && inlineToken.type !== "link") return null;

	const href = String(inlineToken.href ?? "");
	const type = getMediaTypeFromHref(href);
	if (!type) return null;

	const label =
		"text" in inlineToken && typeof inlineToken.text === "string"
			? inlineToken.text
			: "";
	const title =
		"title" in inlineToken && typeof inlineToken.title === "string"
			? inlineToken.title
			: null;

	return { href, label, title, type };
}

function enhanceMediaPreviewTokens(tokens: Token[]) {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const media = getStandaloneMediaToken(token);
		if (media) {
			tokens[i] = {
				type: "html",
				raw: token.raw,
				text: renderMediaPreviewHtml(media),
				pre: false,
			} as Tokens.HTML;
			continue;
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			enhanceMediaPreviewTokens(token.tokens);
		}
	}
}

function normalizeNestedMarkdownCodeFences(source: string) {
	const lines = source.split(/(\r?\n)/);
	const output: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const lineBreak = lines[index + 1] ?? "";
		const opening = line.match(/^(\s*)([`~]{3,})([^`~]*)$/);
		const language = opening?.[3]?.trim().split(/\s+/)[0]?.toLowerCase();
		if (!opening || !["markdown", "md", "mdx"].includes(language ?? "")) {
			output.push(line, lineBreak);
			index += 2;
			continue;
		}

		const marker = opening[2][0];
		const fenceLength = opening[2].length;
		const fencePattern = new RegExp(`^(${marker}{${fenceLength},})(.*)$`);
		const contentStart = index + 2;
		let cursor = contentStart;
		let nestedFenceDepth = 0;
		let closingIndex = -1;
		let maxFenceLength = fenceLength;

		while (cursor < lines.length) {
			const currentLine = lines[cursor] ?? "";
			const currentFence = currentLine.trim().match(fencePattern);
			if (currentFence) {
				maxFenceLength = Math.max(maxFenceLength, currentFence[1].length);
				const info = currentFence[2].trim();
				if (nestedFenceDepth > 0) {
					if (info) nestedFenceDepth += 1;
					else nestedFenceDepth -= 1;
				} else if (info) {
					nestedFenceDepth = 1;
				} else {
					closingIndex = cursor;
					break;
				}
			}
			cursor += 2;
		}

		if (closingIndex === -1) {
			output.push(line, lineBreak);
			index += 2;
			continue;
		}

		const normalizedFence = marker.repeat(maxFenceLength + 1);
		output.push(
			`${opening[1]}${normalizedFence}${opening[3]}`,
			lineBreak,
			...lines.slice(contentStart, closingIndex),
			`${opening[1]}${normalizedFence}`,
			lines[closingIndex + 1] ?? "",
		);
		index = closingIndex + 2;
	}

	return output.join("");
}

async function renderMarkdownHtml(
	source: string,
	options?: { highlight?: boolean },
) {
	const tokens = marked.lexer(normalizeNestedMarkdownCodeFences(source), {
		gfm: true,
	});
	enhanceMediaPreviewTokens(tokens);
	if (options?.highlight !== false) await highlightCodeTokens(tokens);
	return marked.parser(tokens);
}

const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);

function isExternalHttpLink(href: string) {
	try {
		const url = new URL(
			href,
			typeof window === "undefined"
				? "https://cohub.local"
				: window.location.href,
		);
		return (
			EXTERNAL_LINK_PROTOCOLS.has(url.protocol) && /^(https?:)?\/\//i.test(href)
		);
	} catch {
		return false;
	}
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.nodeName !== "A") return;

	const element = node as Element;
	const href = element.getAttribute("href")?.trim();
	if (!href || !isExternalHttpLink(href)) return;

	element.setAttribute("target", "_blank");
	element.setAttribute("rel", "noopener noreferrer");
});

function sanitizeMarkdownHtml(html: string) {
	return DOMPurify.sanitize(html);
}

function isFencedCodeFenceLine(line: string) {
	const match = line.match(/^([`~]{3,})(.*)$/);
	if (!match) return null;
	return { fence: match[1], marker: match[1][0] };
}

type MarkdownBlock = {
	text: string;
	kind: "text" | "fence";
	closedFence: boolean;
};

function splitMarkdownBlocks(source: string): MarkdownBlock[] {
	if (!source) return [];

	const lines = source.split(/\r?\n/);
	const blocks: MarkdownBlock[] = [];
	let buffer: string[] = [];
	let fence: { fence: string; marker: string } | null = null;

	const pushBuffer = () => {
		if (buffer.length === 0) return;
		blocks.push({
			text: buffer.join("\n"),
			kind: fence ? "fence" : "text",
			closedFence: !fence,
		});
		buffer = [];
	};

	for (const line of lines) {
		const fenceState = fence ? isFencedCodeFenceLine(line.trim()) : null;

		if (fence) {
			buffer.push(line);
			if (
				fenceState &&
				fenceState.marker === fence.marker &&
				fenceState.fence.length >= fence.fence.length
			) {
				fence = null;
				pushBuffer();
			}
			continue;
		}

		const openingFence = isFencedCodeFenceLine(line.trim());
		if (openingFence) {
			pushBuffer();
			buffer.push(line);
			fence = openingFence;
			continue;
		}

		buffer.push(line);
	}

	pushBuffer();
	return blocks;
}

function renderPlainCodeBlock(source: string) {
	const lines = source.split(/\r?\n/);
	const openingFence = isFencedCodeFenceLine(lines[0]?.trim() ?? "");
	const language = openingFence
		? lines[0].trim().slice(openingFence.fence.length).trim().split(/\s+/)[0]
		: "";
	const code = openingFence ? lines.slice(1).join("\n") : source;
	const languageClass = language ? ` class="language-${language}"` : "";
	return sanitizeMarkdownHtml(
		`<pre data-streaming-code="true"><code${languageClass}>${escapeHtml(code)}</code></pre>`,
	);
}

function escapeHtml(source: string) {
	return source
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function renderStreamingTail(source: string) {
	if (!source) return "";
	return `<span class="markdown-streaming-tail">${escapeHtml(source)}</span>`;
}

async function renderMarkdownBlock(
	source: string,
	options?: { highlight?: boolean },
) {
	const html = await renderMarkdownHtml(source, options);
	return sanitizeMarkdownHtml(html);
}

export const renderMarkdown = async (source: string) => {
	const normalizedSource = source.trim();
	if (!normalizedSource) return "";

	return cacheMarkdownRender(`full:${normalizedSource}`, async () => {
		return renderMarkdownBlock(normalizedSource);
	});
};

function hasUnclosedInlineMarkdown(source: string) {
	const tail = source.slice(-320);
	const inlineCodeTicks = (tail.match(/(?<!`)`(?!`)/g) ?? []).length;
	if (inlineCodeTicks % 2 === 1) return true;

	const boldStars = (tail.match(/(?<!\*)\*\*(?!\*)/g) ?? []).length;
	const boldUnderscores = (tail.match(/(?<!_)__(?!_)/g) ?? []).length;
	if (boldStars % 2 === 1 || boldUnderscores % 2 === 1) return true;

	const linkOpen = tail.lastIndexOf("[");
	const linkClose = tail.lastIndexOf("]");
	const parenOpen = tail.lastIndexOf("](");
	const parenClose = tail.lastIndexOf(")");
	return linkOpen > linkClose || parenOpen > parenClose;
}

function findStreamingSafeIndex(source: string) {
	const length = source.length;
	if (length < 140) return 0;

	const minTail = source.endsWith("\n")
		? 56
		: Math.min(260, Math.max(84, Math.floor(length * 0.13)));
	const maxStableIndex = Math.max(0, length - minTail);
	const searchStart = Math.max(0, maxStableIndex - 1200);
	const window = source.slice(searchStart, maxStableIndex);
	const candidates: number[] = [];

	// With live Markdown repaired by remend, the current unfinished block can stay
	// in the live renderer. Promoting only at block boundaries avoids splitting a
	// single paragraph into stable/live <p> nodes, which otherwise causes already
	// streamed prose to rewrap and drift downward as the boundary moves.
	for (const match of window.matchAll(/\n\s*\n/g)) {
		candidates.push(searchStart + match.index + match[0].length);
	}

	candidates.sort((a, b) => b - a);
	for (const candidate of candidates) {
		const stable = source.slice(0, candidate);
		const tail = source.slice(candidate);
		if (!stable.trim()) continue;
		if (tail.length > 900) continue;
		if (hasUnclosedInlineMarkdown(stable.slice(-480))) continue;
		return candidate;
	}

	return 0;
}

export function splitStreamingStableMarkdown(source: string) {
	const safeIndex = findStreamingSafeIndex(source);
	return {
		stable: source.slice(0, safeIndex),
		tail: source.slice(safeIndex),
	};
}

function countMarkdownBlockMarkers(source: string) {
	const headingCount = (source.match(/^#{1,6}\s/gm) ?? []).length;
	const listCount = (source.match(/^\s*(?:[-+*]|\d+[.)])\s+/gm) ?? []).length;
	const quoteCount = (source.match(/^>\s?/gm) ?? []).length;
	const fenceCount = (source.match(/^\s*([`~]{3,})/gm) ?? []).length;
	return headingCount + listCount + quoteCount + fenceCount;
}

function repairStreamingMarkdown(source: string) {
	return remend(source, {
		images: false,
		katex: false,
		inlineKatex: false,
	});
}

export const renderStreamingMarkdownLive = async (source: string) => {
	const streamingSource = source.trimStart();
	if (!streamingSource.trim()) return "";
	return cacheMarkdownRender(`stream-live:${streamingSource}`, async () =>
		renderMarkdownBlock(repairStreamingMarkdown(streamingSource), {
			highlight: false,
		}),
	);
};

export const renderStreamingMarkdownBlocks = async (source: string) => {
	const streamingSource = source.trimStart();
	if (!streamingSource.trim()) return "";

	const blocks = splitMarkdownBlocks(streamingSource);
	if (blocks.length === 0) return "";

	const renderedBlocks = await Promise.all(
		blocks.map((block, index) => {
			const isLast = index === blocks.length - 1;
			const shouldRepair = isLast && !block.closedFence;
			const cacheKey = shouldRepair
				? `stream-live-block:${block.text}`
				: `stream-complete-block:${block.text}`;
			return cacheMarkdownRender(cacheKey, async () =>
				renderMarkdownBlock(
					shouldRepair ? repairStreamingMarkdown(block.text) : block.text,
					{ highlight: false },
				),
			);
		}),
	);

	return renderedBlocks.filter(Boolean).join("\n\n");
};

export const renderStreamingMarkdownStable = async (source: string) => {
	const streamingSource = source.trimStart();
	if (!streamingSource.trim()) {
		return { stableSource: "", tailSource: "", stableHtml: "" };
	}

	const blocks = splitMarkdownBlocks(streamingSource);
	if (blocks.length === 0) {
		return { stableSource: "", tailSource: streamingSource, stableHtml: "" };
	}

	const stableSources: string[] = [];
	let tailSource = "";

	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const isLast = index === blocks.length - 1;
		if (block.kind === "fence") {
			if (block.closedFence || !isLast) stableSources.push(block.text);
			else tailSource = block.text;
			continue;
		}

		if (!isLast) {
			stableSources.push(block.text);
			continue;
		}

		const { stable, tail } = splitStreamingStableMarkdown(block.text);
		if (stable.trim()) stableSources.push(stable);
		tailSource = tail;
	}

	const stableSource = stableSources.join("\n\n");
	const hasMeaningfulTail = tailSource.trim().length > 0;
	const stableHtml = stableSource.trim()
		? await cacheMarkdownRender(`stream-stable-v2:${stableSource}`, async () =>
				renderMarkdownBlock(stableSource, {
					highlight:
						!hasMeaningfulTail || countMarkdownBlockMarkers(stableSource) <= 1,
				}),
			)
		: "";

	return { stableSource, tailSource, stableHtml };
};

export const renderStreamingMarkdown = async (source: string) => {
	const streamingSource = source.trimStart();
	if (!streamingSource.trim()) return "";

	const blocks = splitMarkdownBlocks(streamingSource);
	if (blocks.length === 0) return "";

	const renderedBlocks = await Promise.all(
		blocks.map(async (block, index) => {
			const isLast = index === blocks.length - 1;
			if (block.kind === "fence") return renderPlainCodeBlock(block.text);

			if (
				isLast &&
				/^\s*([`~]{3,})[\s\S]*\n\1\s*$/.test(block.text) &&
				block.text.trim().length < 120
			) {
				return renderPlainCodeBlock(block.text);
			}

			const shouldRenderWholeLastBlock =
				isLast &&
				block.text.endsWith("\n") &&
				block.text.trim().length < 120 &&
				!hasUnclosedInlineMarkdown(block.text);
			if (shouldRenderWholeLastBlock) {
				return renderMarkdownBlock(block.text, { highlight: false });
			}

			if (!isLast) {
				return cacheMarkdownRender(`stream-block:${block.text}`, async () =>
					renderMarkdownBlock(block.text, { highlight: false }),
				);
			}

			const { stable, tail } = splitStreamingStableMarkdown(block.text);
			const stableHtml = stable.trim()
				? await cacheMarkdownRender(`stream-stable:${stable}`, async () =>
						renderMarkdownBlock(stable, { highlight: false }),
					)
				: "";
			return [stableHtml, renderStreamingTail(tail)].filter(Boolean).join("\n");
		}),
	);

	return renderedBlocks.filter(Boolean).join("\n\n");
};
