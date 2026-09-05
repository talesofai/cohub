export const DEFAULT_PWA_THEME_COLOR = "#F8F8FA";
export const DEFAULT_PWA_BACKGROUND_COLOR = "#F8F8FA";

/**
 * Keep browser chrome aligned with the actual shell background, including
 * space-level custom theme.css overrides. RGB output is used for compatibility
 * with older Android WebView/Chrome versions that do not parse OKLCH metadata.
 */
export function syncSystemChromeColor(fallback = DEFAULT_PWA_THEME_COLOR) {
	if (typeof document === "undefined") return;

	const rootColor = getComputedStyle(document.documentElement)
		.getPropertyValue("--bg-primary")
		.trim();
	const color = resolveCssColor(rootColor) ?? fallback;

	for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
		meta.setAttribute("content", color);
	}
}

function resolveCssColor(value: string): string | null {
	if (!value || typeof document === "undefined" || !document.body) return null;

	const probe = document.createElement("span");
	probe.style.color = value;
	if (!probe.style.color) return null;
	probe.hidden = true;
	document.body.append(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	return resolved || null;
}
