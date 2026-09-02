import {
  parseBoardEffectInput,
  parseBoardCompositionInput,
  type BoardComposition,
  type BoardEffect,
} from "@neta-art/cohub";
import type { Command } from "commander";
import {
  BOARD_DOMAIN_INPUT_MAX_BYTES,
  readBoardJsonObject,
} from "../../board-command-support.js";
import { handleHttp, json, jsonRequested, table } from "../../output.js";
import {
  mutateSemantic,
  readInput,
  readOptions,
  type JsonOptions,
  resolvedBoard,
  showUpdated,
  withJson,
} from "./context.js";

export function registerBoardAnimationCommands(boards: Command): void {
  const effects = boards.command("effects").description("Manage Board effects");
  readOptions(withJson(effects.command("list <board>").alias("ls").description("List effects")))
    .action(async (target: string, options: JsonOptions & { ids?: string }) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring(readInput(options, "effects"));
        const effects = result.effects ?? [];
        if (jsonRequested(options)) return json(effects);
        table(effects, [
          { key: "id", label: "ID" },
          { key: "kind", label: "KIND" },
          { key: "enabled", label: "ENABLED" },
          { key: "layer", label: "LAYER" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });
  withJson(effects.command("get <board> <effect-id>").description("Get one complete Board effect"))
    .action(async (target: string, effectId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring({ include: ["effects"], effectIds: [effectId] });
        const effect = result.effects?.[0];
        if (!effect) throw new Error(`Effect not found: ${effectId}`);
        if (jsonRequested(options)) return json(effect);
        table([effect], [
          { key: "id", label: "ID" },
          { key: "kind", label: "KIND" },
          { key: "enabled", label: "ENABLED" },
          { key: "layer", label: "LAYER" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(effects.command("apply <board>")
    .description("Atomically create or replace an effect")
    .requiredOption("-i, --input <file>", "Board effect JSON; use - for stdin")
    .addHelpText("after", `
Create a template:
  cohub boards examples effect pulse > effect.json

Discover supported effect kinds:
  cohub boards capabilities <board> --json`))
    .action(async (target: string, options: JsonOptions & { input: string }) => {
      try {
        const input = await readBoardJsonObject(options.input, BOARD_DOMAIN_INPUT_MAX_BYTES);
        const effect = parseBoardEffectInput(input) as Omit<BoardEffect, "boardId" | "revision">;
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "effect.apply", effect }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });
  withJson(effects.command("delete <board> <effect-id>").alias("rm").description("Delete an effect"))
    .action(async (target: string, effectId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "effect.delete", effectId }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  const compositions = boards
    .command("compositions")
    .description("Manage atomic Board animation compositions");

  readOptions(withJson(compositions.command("list <board>").alias("ls").description("List compositions")))
    .action(async (target: string, options: JsonOptions & { ids?: string }) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring(readInput(options, "compositions"));
        const compositions = result.compositions ?? [];
        if (jsonRequested(options)) return json(compositions);
        table(compositions.map((composition) => ({
          id: composition.id,
          name: composition.name,
          duration: composition.timeline.duration,
          tracks: composition.timeline.tracks.length,
          clips: composition.timeline.clips.length,
          revision: composition.revision,
        })), [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "duration", label: "DURATION" },
          { key: "tracks", label: "TRACKS" },
          { key: "clips", label: "CLIPS" },
          { key: "revision", label: "REVISION" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(compositions.command("get <board> <composition-id>").description("Get one complete composition"))
    .action(async (target: string, compositionId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring({ include: ["compositions"], compositionIds: [compositionId] });
        const composition = result.compositions?.[0];
        if (!composition) throw new Error(`Composition not found: ${compositionId}`);
        if (jsonRequested(options)) return json(composition);
        table([{
          id: composition.id,
          name: composition.name,
          duration: composition.timeline.duration,
          tracks: composition.timeline.tracks.length,
          clips: composition.timeline.clips.length,
          revision: composition.revision,
        }], [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "duration", label: "DURATION" },
          { key: "tracks", label: "TRACKS" },
          { key: "clips", label: "CLIPS" },
          { key: "revision", label: "REVISION" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(compositions.command("apply <board>")
    .description("Atomically create or replace a composition")
    .requiredOption("-i, --input <file>", "BoardComposition JSON; use - for stdin")
    .addHelpText("after", `
Property changes use timeline.tracks with registered channels and keyframes.
Procedural behavior such as text reveal, particles, and camera focus uses timeline.clips.
Run boards capabilities to discover channels and clip schemas.
Create an editable template with:
  cohub boards examples composition fade > intro.json

Minimal fade composition:
  {"id":"intro","name":"Intro","timeline":{"duration":800,"tracks":[{"id":"title-opacity","target":{"type":"item","itemId":"title"},"channel":"style.opacity","fill":"both","keyframes":[{"time":0,"value":0},{"time":800,"value":1,"easing":"ease-out-cubic"}]}],"clips":[],"markers":[]},"playback":{"loop":false,"endBehavior":"hold","reducedMotion":{"mode":"base"}}}`))
    .action(async (target: string, options: JsonOptions & { input: string }) => {
      try {
        const input = await readBoardJsonObject(options.input, BOARD_DOMAIN_INPUT_MAX_BYTES);
        const composition = parseBoardCompositionInput(input) as Omit<BoardComposition, "revision">;
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "composition.apply", composition }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(compositions.command("delete <board> <composition-id>").alias("rm").description("Delete a composition"))
    .action(async (target: string, compositionId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "composition.delete", compositionId }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
