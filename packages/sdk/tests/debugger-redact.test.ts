import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type SerializedValue,
	redactText,
	redactUrl,
	redactValue,
} from "../src/debugger.js";

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const SECRET_PREFIX_RE =
	/\b(?:sk-[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|pat_[A-Za-z0-9_]{16,})/;

// Synthetic fixtures shaped like production payloads for redaction tests.
const WS_AUTH_MESSAGE = `{"type":"auth","payload":{"token":"eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJzY29wZSI6ImZha2UifQ.fake-signature-for-redact-tests"}}`;

const SPACE_SECRETS_RESPONSE = `{"secrets":[{"name":"NETA_TOKEN","value":"eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.fake-signature"},{"name":"PROVIDER_API_KEY","value":"sk-test_fake_key_not_real_000000"},{"name":"GITHUB_PAT","value":"ghp_testfakefakefakefake00"},{"name":"GIT_TOKEN","value":"github_pat_test_fake_not_real_000000000000000000000000000000000000"}],"gitToken":"github_pat_test_fake_not_real_000000000000000000000000000000000000","repoUrl":"https://github.com/example/example-agent.git"}`;

test("redactText scrubs the WebSocket auth token and leaves the message structure intact", () => {
	const out = redactText(WS_AUTH_MESSAGE);
	assert.equal(JWT_RE.test(out), false, "JWT must be gone");
	assert.ok(
		out.includes('"token":"[redacted]"'),
		`token value must be redacted in place, got: ${out}`,
	);
	assert.ok(out.includes('"type":"auth"'), "non-sensitive fields preserved");
});

test("redactText scrubs JWTs, sk-/ghp_/github_pat_ prefixes and sensitive JSON keys from response bodies", () => {
	const out = redactText(SPACE_SECRETS_RESPONSE);
	assert.equal(JWT_RE.test(out), false, "no JWT may remain");
	assert.equal(SECRET_PREFIX_RE.test(out), false, "no prefixed secret may remain");
	assert.ok(
		out.includes('"gitToken":"[redacted]"'),
		"sensitive JSON key value must be redacted",
	);
	assert.ok(
		out.includes('"repoUrl":"https://github.com/example/example-agent.git"'),
		"non-secret repoUrl must be preserved",
	);
});

test("redactText redacts Bearer tokens", () => {
	const out = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.abc1234567890 done");
	assert.ok(out.includes("Bearer [redacted]"), `bearer redacted, got: ${out}`);
	assert.equal(JWT_RE.test(out), false, "no JWT residue");
});

test("redactText fast-paths benign text unchanged", () => {
	const benign = "lorem ipsum dolor sit amet ".repeat(5);
	assert.equal(redactText(benign), benign);
	assert.equal(redactText(""), "");
});

test("redactValue redacts sensitive keys by name at any depth", () => {
	const input: SerializedValue = {
		token: "eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.abc1234567890",
		normal: "keep-me",
		nested: { apiKey: "sk-test_fake_key_not_real_000000", count: 3 },
		list: [{ password: "p@ss" }, { ok: true }],
	};
	const out = redactValue(input) as Record<string, unknown>;
	assert.equal(out.token, "[redacted]");
	assert.equal(out.normal, "keep-me");
	assert.equal(
		(out.nested as Record<string, unknown>).apiKey,
		"[redacted]",
	);
	assert.equal(
		(out.list as Array<Record<string, unknown>>)[0]?.password,
		"[redacted]",
	);
});

test("redactValue scrubs secrets inside plain string payloads", () => {
	const out = redactValue(
		"Bearer eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.abc1234567890 tail",
	);
	assert.equal(typeof out, "string");
	assert.ok(
		(out as string).includes("Bearer [redacted]"),
		"bearer redacted in string payload",
	);
	assert.equal(JWT_RE.test(out as string), false);
});

test("redactUrl redacts sensitive query params and preserves everything else", () => {
	assert.equal(
		redactUrl("https://api.cohub.run/api/x?spaceId=abc&token=secret123&limit=20"),
		"https://api.cohub.run/api/x?spaceId=abc&token=[redacted]&limit=20",
	);
	assert.equal(
		redactUrl("https://api.cohub.run/api/x?access_token=t&apiKey=k"),
		"https://api.cohub.run/api/x?access_token=[redacted]&apiKey=[redacted]",
	);
	assert.equal(
		redactUrl("wss://gateway.cohub.run/ws"),
		"wss://gateway.cohub.run/ws",
		"url without query is untouched",
	);
	assert.equal(
		redactUrl("/api/me?token=t"),
		"/api/me?token=[redacted]",
		"relative url form is preserved",
	);
});
