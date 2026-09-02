import { validatePublicIdentifierAssignment } from "@cohub/protocol/public-identifiers";

const PUBLIC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

export const USERNAME_RULE_HINT =
	"Use 1-39 lowercase letters, numbers, or hyphens. No leading, trailing, or repeated hyphens.";
export const PUBLIC_SLUG_RULE_HINT =
	"Use 1-80 lowercase letters, numbers, hyphens, or underscores. No leading or trailing separators.";

export function normalizeUsernameInput(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 39);
}

export function normalizePublicSlugInput(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
		.slice(0, 80);
}

export function validateUsernameInput(
	value: string,
	options?: { required?: boolean },
) {
	const username = normalizeUsernameInput(value);
	if (!username) {
		return options?.required
			? { value: null, error: "Username is required." }
			: { value: null, error: null };
	}
	const validation = validatePublicIdentifierAssignment("username", username);
	if (validation.reason === "format") {
		return { value: null, error: USERNAME_RULE_HINT };
	}
	if (validation.reason === "reserved") {
		return { value: null, error: "This username is reserved." };
	}
	return { value: validation.value, error: null };
}

function validatePublicSlugInput(
	value: string,
	options?: { required?: boolean; label?: string },
) {
	const label = options?.label ?? "Slug";
	const slug = normalizePublicSlugInput(value);
	if (!slug) {
		return options?.required
			? { value: null, error: `${label} is required.` }
			: { value: null, error: null };
	}
	if (!PUBLIC_SLUG_PATTERN.test(slug)) {
		return { value: null, error: PUBLIC_SLUG_RULE_HINT };
	}
	return { value: slug, error: null };
}

export function validateSpaceSlugInput(
	value: string,
	options?: {
		required?: boolean;
		label?: string;
		currentValue?: string | null;
	},
) {
	const result = validatePublicSlugInput(value, options);
	if (
		options &&
		"currentValue" in options &&
		result.value === options.currentValue
	) {
		return result;
	}
	if (!result.value || result.error) return result;
	const validation = validatePublicIdentifierAssignment(
		"spaceSlug",
		result.value,
	);
	if (validation.reason === "reserved") {
		return { value: null, error: "This Space slug is reserved." };
	}
	return result;
}

export function validateAppSlugInput(
	value: string,
	options?: { required?: boolean; label?: string },
) {
	return validatePublicSlugInput(value, options);
}
