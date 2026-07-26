import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateProxyContextTokens, resolveReserveTokens } from "../runtime/compaction-policy.js";

const asMessages = (messages: unknown[]) => messages as AgentMessage[];

const textMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const imageMessage = (base64Chars: number) => ({
  role: "user",
  content: [{ type: "image", data: "a".repeat(base64Chars), mimeType: "image/webp" }],
});

// ── Text is charged at the usual ~4 chars/token ──
assert.equal(estimateProxyContextTokens(asMessages([textMessage("a".repeat(400))])), 100);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: "a".repeat(40) }])), 10);

// ── Inline base64 images are charged at ~2 chars/token, not pi's flat 1.2k ──
assert.equal(estimateProxyContextTokens(asMessages([imageMessage(200_000)])), 100_000);

// ── Mixed content sums both views ──
assert.equal(
  estimateProxyContextTokens(asMessages([textMessage("a".repeat(400)), imageMessage(1_000)])),
  100 + 500,
);

// ── Thinking blocks and unknown block shapes still contribute ──
assert.equal(
  estimateProxyContextTokens(asMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(40) }] }])),
  10,
);
assert.ok(
  estimateProxyContextTokens(asMessages([{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } }] }])) > 0,
);

// ── Malformed content never throws ──
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user" }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: null }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: [null, 42, "raw"] }])), 0);
assert.equal(estimateProxyContextTokens(asMessages([])), 0);

// ── Images without usable data are ignored rather than guessed at ──
assert.equal(estimateProxyContextTokens(asMessages([{ role: "user", content: [{ type: "image", mimeType: "image/webp" }] }])), 0);

// ── Regression: session f17dad70 sat below the threshold and never auto-compacted ──
// 45 normalized images (~196k base64 chars each) plus ~324k chars of text. The
// provider reported 4,564,921 tokens against a 1M window while pi's estimate
// stayed at ~189k, so shouldCompact never fired.
const contextWindow = 1_000_000;
const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: resolveReserveTokens(contextWindow) };
const stuckSession = asMessages([
  textMessage("a".repeat(324_000)),
  ...Array.from({ length: 45 }, () => imageMessage(196_074)),
]);

const proxyTokens = estimateProxyContextTokens(stuckSession);
assert.ok(
  proxyTokens > 4_000_000 && proxyTokens < 5_000_000,
  `expected proxy estimate near the reported 4.56M, got ${proxyTokens}`,
);

// pi's own view of the same context stays far below the threshold …
assert.equal(shouldCompact(189_451, contextWindow, settings), false);
// … while the base64-aware lower bound triggers compaction before the 413.
assert.equal(shouldCompact(Math.max(189_451, proxyTokens), contextWindow, settings), true);

// ── An image-free session is unaffected by the new lower bound ──
const textOnlySession = asMessages([textMessage("a".repeat(400_000))]);
assert.equal(estimateProxyContextTokens(textOnlySession), 100_000);
assert.equal(shouldCompact(Math.max(100_000, estimateProxyContextTokens(textOnlySession)), contextWindow, settings), false);

// ── Reserve tokens scale down for small windows, cap for large ones ──
assert.equal(resolveReserveTokens(1_000_000), 32_768);
assert.equal(resolveReserveTokens(8_000), 2_000);
assert.equal(resolveReserveTokens(0), 32_768);
assert.ok(resolveReserveTokens(4) >= 1);

console.log("compaction-policy: ok");
