import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
  parseAsrExperimentVariants,
  selectAsrExperimentVariant,
} from "../src/asr/experiments.js";
import {
  buildVolcCorpusContext,
  normalizeAsrSessionOptions,
} from "../src/asr/options.js";
import { postprocessAsrText } from "../src/asr/postprocess.js";
import { rewriteAsrText } from "../src/asr/rewrite.js";
import { encodeFullClientRequest } from "../src/asr/volc-asr-protocol.js";

const decodeFullClientRequest = (frame: Buffer) => {
  const payloadSize = frame.readUInt32BE(4);
  const payload = frame.subarray(8, 8 + payloadSize);
  return JSON.parse(gunzipSync(payload).toString("utf-8")) as Record<
    string,
    unknown
  >;
};

test("normalizeAsrSessionOptions clamps endpoint tuning and deduplicates context terms", () => {
  const options = normalizeAsrSessionOptions({
    language: "zh-CN",
    asr: {
      endWindowSizeMs: 50,
      forceToSpeechTimeMs: 20_000,
      hotwords: ["Cohub", " cohub ", "Neta"],
      contextMessages: [" previous prompt ", ""],
      contextText: " current composer text ",
      postProcessing: { cleanupFillers: false },
    },
  });

  assert.equal(options.language, "zh-CN");
  assert.equal(options.endWindowSizeMs, 200);
  assert.equal(options.forceToSpeechTimeMs, 10_000);
  assert.deepEqual(options.hotwords, ["Cohub", "Neta"]);
  assert.deepEqual(options.contextMessages, ["previous prompt"]);
  assert.equal(options.contextText, "current composer text");
  assert.equal(options.postProcessing.cleanupFillers, false);
  assert.equal(options.postProcessing.normalizeWhitespace, true);
});

test("buildVolcCorpusContext serializes hotwords and newest context", () => {
  const options = normalizeAsrSessionOptions({
    asr: {
      hotwords: ["Cohub"],
      contextMessages: ["latest assistant message"],
      contextText: "composer prefix",
    },
  });
  const context = buildVolcCorpusContext(options);

  assert.equal(
    context,
    JSON.stringify({
      hotwords: [{ word: "Cohub" }],
      context_type: "dialog_ctx",
      context_data: [
        { text: "latest assistant message" },
        { text: "composer prefix" },
      ],
    }),
  );
});

test("encodeFullClientRequest maps ASR tuning into the Volc request payload", () => {
  const payload = decodeFullClientRequest(
    encodeFullClientRequest({
      uid: "user-1",
      endWindowSizeMs: 600,
      forceToSpeechTimeMs: 1000,
      enableNonstream: true,
      enablePunctuation: true,
      enableItn: true,
      enableDdc: false,
      corpus: {
        boostingTableId: "table-1",
        context: JSON.stringify({ hotwords: [{ word: "Cohub" }] }),
      },
    }),
  );
  const request = payload.request as Record<string, unknown>;
  const corpus = request.corpus as Record<string, unknown>;

  assert.equal(request.end_window_size, 600);
  assert.equal(request.force_to_speech_time, 1000);
  assert.equal(request.enable_nonstream, true);
  assert.equal(request.ssd_version, "200");
  assert.equal(corpus.boosting_table_id, "table-1");
  assert.equal(
    corpus.context,
    JSON.stringify({ hotwords: [{ word: "Cohub" }] }),
  );
});

test("postprocessAsrText applies conservative cleanup", () => {
  const options = normalizeAsrSessionOptions({
    asr: {
      hotwords: ["Cohub"],
    },
  });

  assert.equal(
    postprocessAsrText("um cohub  ,  hello!!", options),
    "Cohub, hello!",
  );
});

test("postprocessAsrText does not remove meaningful Chinese sequencing terms", () => {
  const options = normalizeAsrSessionOptions(undefined);

  assert.equal(
    postprocessAsrText("先做 A，然后，做 B", options),
    "先做 A，然后，做 B",
  );
});

test("parseAsrExperimentVariants accepts safe endpoint variants", () => {
  const variants = parseAsrExperimentVariants(
    JSON.stringify([
      {
        name: "fast",
        weight: 1,
        options: { endWindowSizeMs: 600, enableDdc: false },
      },
      {
        name: "patient",
        weight: 2,
        options: { endWindowSizeMs: 1200, forceToSpeechTimeMs: 1200 },
      },
      { name: "", weight: 1, options: { endWindowSizeMs: 800 } },
    ]),
  );

  assert.equal(variants.length, 2);
  assert.deepEqual(variants[0], {
    name: "fast",
    weight: 1,
    options: { endWindowSizeMs: 600, enableDdc: false },
  });
});

test("parseAsrExperimentVariants clamps endpoint variant tuning", () => {
  const variants = parseAsrExperimentVariants(
    JSON.stringify([
      {
        name: "unsafe",
        weight: 1,
        options: { endWindowSizeMs: -1, forceToSpeechTimeMs: 50_000 },
      },
    ]),
  );

  assert.deepEqual(variants[0]?.options, {
    endWindowSizeMs: 200,
    forceToSpeechTimeMs: 10_000,
  });
});

test("selectAsrExperimentVariant is stable for the same seed", () => {
  const variants = parseAsrExperimentVariants(
    JSON.stringify([
      { name: "a", weight: 1, options: { endWindowSizeMs: 600 } },
      { name: "b", weight: 1, options: { endWindowSizeMs: 1000 } },
    ]),
  );

  assert.equal(
    selectAsrExperimentVariant(variants, "user-1:request-1")?.name,
    selectAsrExperimentVariant(variants, "user-1:request-1")?.name,
  );
});

test("rewriteAsrText falls back to rule cleanup when LLM rewrite is disabled", async () => {
  const options = normalizeAsrSessionOptions({ asr: { hotwords: ["Cohub"] } });

  assert.deepEqual(await rewriteAsrText("um cohub  ,  hello!!", options), {
    text: "Cohub, hello!",
    originalText: "Cohub, hello!",
    alternatives: [],
    rewritten: false,
  });
});
