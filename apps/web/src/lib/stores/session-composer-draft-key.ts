import { encodeKeyPart, getCacheUserKey } from "$lib/cache/keys";

const STORAGE_PREFIX = "cohub:session-composer-draft:v1";

type ComposerDraftScope =
	| { kind: "new" }
	| { kind: "session"; sessionId: string };

export function sessionComposerDraftKey(
	spaceId: string,
	scope: ComposerDraftScope,
) {
	const scopeKey = scope.kind === "new" ? "new" : `session:${scope.sessionId}`;
	return [STORAGE_PREFIX, getCacheUserKey(), spaceId, scopeKey]
		.map(encodeKeyPart)
		.join(":");
}
