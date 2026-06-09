import type { VoiceLexiconEntry, VoiceLexiconSource } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { table, json as outJson, jsonRequested, ok, error, handleHttp } from "../output.js";
import { resolveSpace } from "../space.js";

type VoiceLexiconOptions = {
  json?: boolean;
  source?: string;
  originalText?: string;
};

const VOICE_LEXICON_SOURCES = ["manual", "auto", "correction"] as const;

function parseVoiceLexiconSource(value: string | undefined): VoiceLexiconSource {
  if (value === undefined) return "manual";
  if ((VOICE_LEXICON_SOURCES as readonly string[]).includes(value)) {
    return value as VoiceLexiconSource;
  }
  return error("Invalid source", `Use one of: ${VOICE_LEXICON_SOURCES.join(", ")}`);
}

function renderVoiceLexicon(items: VoiceLexiconEntry[], opts: { json?: boolean }): void {
  if (jsonRequested(opts)) {
    outJson({ items });
    return;
  }
  table(items, [
    { key: "id", label: "ID" },
    { key: "scope", label: "Scope" },
    { key: "term", label: "Term" },
    { key: "source", label: "Source" },
    { key: "usageCount", label: "Uses" },
  ]);
}

export function registerVoice(program: Command): void {
  const voiceCmd = program.command("voice").description("Manage voice input");
  const termsCmd = voiceCmd.command("terms").description("Manage personal voice terms");

  termsCmd
    .command("ls")
    .alias("list")
    .description("List personal voice terms")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.user.getVoiceLexicon();
        renderVoiceLexicon(result.items, opts);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  termsCmd
    .command("add <term>")
    .description("Add a personal voice term")
    .option("--source <source>", "Term source: manual, auto, or correction")
    .option("--original-text <text>", "Original text this term corrected")
    .option("--json", "Output as JSON")
    .action(async (term: string, opts: VoiceLexiconOptions) => {
      const client = createClient();
      try {
        const result = await client.user.addVoiceLexiconEntry({
          term,
          source: parseVoiceLexiconSource(opts.source),
          originalText: opts.originalText,
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Voice term saved: ${result.item.term}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  termsCmd
    .command("update <entryId> <term>")
    .description("Update a personal voice term")
    .option("--source <source>", "Term source: manual, auto, or correction")
    .option("--original-text <text>", "Original text this term corrected")
    .option("--json", "Output as JSON")
    .action(async (entryId: string, term: string, opts: VoiceLexiconOptions) => {
      const client = createClient();
      try {
        const result = await client.user.updateVoiceLexiconEntry(entryId, {
          term,
          source: parseVoiceLexiconSource(opts.source),
          originalText: opts.originalText,
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Voice term updated: ${result.item.term}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  termsCmd
    .command("rm <entryId>")
    .alias("delete")
    .description("Delete a personal voice term")
    .action(async (entryId: string) => {
      const client = createClient();
      try {
        await client.user.deleteVoiceLexiconEntry(entryId);
        ok("Voice term deleted");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}

export function registerSpaceVoiceLexicon(spacesCmd: Command): void {
  const voiceLexiconCmd = spacesCmd
    .command("voice-lexicon")
    .alias("voice")
    .description("Manage shared space voice terms")
    .hook("preAction", () => { resolveSpace(spacesCmd); });

  voiceLexiconCmd
    .command("ls")
    .alias("list")
    .description("List shared space voice terms")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).voiceLexicon.list();
        renderVoiceLexicon(result.items, opts);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  voiceLexiconCmd
    .command("add <term>")
    .description("Add a shared space voice term")
    .option("--source <source>", "Term source: manual, auto, or correction")
    .option("--original-text <text>", "Original text this term corrected")
    .option("--json", "Output as JSON")
    .action(async (term: string, opts: VoiceLexiconOptions) => {
      const spaceId = resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).voiceLexicon.add({
          term,
          source: parseVoiceLexiconSource(opts.source),
          originalText: opts.originalText,
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Voice term saved: ${result.item.term}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  voiceLexiconCmd
    .command("update <entryId> <term>")
    .description("Update a shared space voice term")
    .option("--source <source>", "Term source: manual, auto, or correction")
    .option("--original-text <text>", "Original text this term corrected")
    .option("--json", "Output as JSON")
    .action(async (entryId: string, term: string, opts: VoiceLexiconOptions) => {
      const spaceId = resolveSpace(spacesCmd);
      const client = createClient();
      try {
        const result = await client.space(spaceId).voiceLexicon.update(entryId, {
          term,
          source: parseVoiceLexiconSource(opts.source),
          originalText: opts.originalText,
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Voice term updated: ${result.item.term}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  voiceLexiconCmd
    .command("rm <entryId>")
    .alias("delete")
    .description("Delete a shared space voice term")
    .action(async (entryId: string) => {
      const spaceId = resolveSpace(spacesCmd);
      const client = createClient();
      try {
        await client.space(spaceId).voiceLexicon.delete(entryId);
        ok("Voice term deleted");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
