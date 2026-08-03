type FriendlySpaceLoadError = {
	status: 401 | 403 | 404 | 500;
	message: string;
};

export function mapFriendlySpaceLoadError(
	cause: unknown,
): FriendlySpaceLoadError {
	if (cause instanceof Error && cause.name === "HttpError") {
		const status = (cause as Error & { status?: unknown }).status;
		if (status === 404) return { status: 404, message: "Space not found" };
		if (status === 401) {
			return { status: 401, message: "Sign in to access this Space" };
		}
		if (status === 403) {
			return { status: 403, message: "You do not have access to this Space" };
		}
	}
	return { status: 500, message: "Failed to load Space" };
}
