import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_BUILTIN_CLIP_KINDS,
  BOARD_BUILTIN_EFFECT_KINDS,
  BoardAuthoringItemSchema,
  BoardCompositionInputSchema,
  BoardCreateInputSchema,
  BoardEffectSchema,
  BoardSemanticCommandSchema,
  validateBuiltinBoardClip,
  validateBuiltinBoardEffect,
} from "@cohub/protocol";
import { Command } from "commander";
import {
  BOARD_EXAMPLE_KEYS,
  boardExample,
  registerBoardExampleCommands,
} from "../src/commands/boards/examples.js";
import { parseBatchCommands } from "../src/commands/boards/batch.js";
import {
  parseJsonObject,
  parseViewport,
  registerBoards,
  showCreated,
} from "../src/commands/boards.js";

function createProgram(): { program: Command; boards: Command } {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target space ID")
    .helpOption("-h, --help", "Show help");
  return { program, boards: registerBoards(program) };
}

test("Board commands and every subcommand expose -h", () => {
  const { boards } = createProgram();
  const names = boards.commands.map((command) => command.name());
  assert.deepEqual(names, [
    "create",
    "inspect",
    "capabilities",
    "examples",
    "rename",
    "background",
    "playback-policy",
    "batch",
    "connections",
    "items",
    "effects",
    "compositions",
    "export",
    "playback",
    "watch",
  ]);
  assert.match(boards.helpInformation(), /-h, --help/);
  for (const command of boards.commands) {
    assert.match(command.helpInformation(), /-h, --help/, `${command.name()} is missing -h`);
    for (const child of command.commands) {
      assert.match(child.helpInformation(), /-h, --help/, `${command.name()} ${child.name()} is missing -h`);
    }
  }
  const playback = boards.commands.find((command) => command.name() === "playback");
  assert.ok(playback);
  const play = playback.commands.find((command) => command.name() === "play");
  assert.ok(play);
  assert.doesNotMatch(play.helpInformation(), /--loop/);
});

test("every Board example is valid semantic input", () => {
  const effectInput = BoardEffectSchema.omit({ boardId: true, revision: true });
  for (const key of BOARD_EXAMPLE_KEYS) {
    const [kind, type] = key.split(":");
    const value = boardExample(kind as string, type);
    if (kind === "batch") {
      const batch = value as { commands?: unknown[] };
      assert.ok(Array.isArray(batch.commands));
      for (const command of batch.commands) assert.equal(BoardSemanticCommandSchema.safeParse(command).success, true, key);
      continue;
    }
    const schema = kind === "create"
      ? BoardCreateInputSchema.omit({ path: true, mutationId: true })
      : kind === "item"
        ? BoardAuthoringItemSchema
        : kind === "effect"
          ? effectInput
          : BoardCompositionInputSchema;
    const parsed = schema.safeParse(value);
    assert.equal(parsed.success, true, key);
    if (parsed.success && kind === "composition") {
      for (const clip of BoardCompositionInputSchema.parse(parsed.data).timeline.clips) {
        assert.deepEqual(validateBuiltinBoardClip(clip), [], `${key}: ${clip.kind}`);
      }
    }
    if (parsed.success && kind === "effect") {
      assert.deepEqual(validateBuiltinBoardEffect(effectInput.parse(parsed.data)), [], key);
    }
  }
});

test("Board examples cover every built-in animation capability", () => {
  const clipKinds = new Set<string>();
  const effectKinds = new Set<string>();
  for (const key of BOARD_EXAMPLE_KEYS) {
    const [kind, type] = key.split(":");
    const value = boardExample(kind as string, type);
    if (kind === "composition") {
      const composition = BoardCompositionInputSchema.parse(value);
      for (const clip of composition.timeline.clips) clipKinds.add(clip.kind);
    }
    if (kind === "effect") {
      effectKinds.add(BoardEffectSchema.omit({ boardId: true, revision: true }).parse(value).kind);
    }
  }
  assert.deepEqual([...clipKinds].sort(), [...BOARD_BUILTIN_CLIP_KINDS].sort());
  assert.deepEqual([...effectKinds].sort(), [...BOARD_BUILTIN_EFFECT_KINDS].sort());
});

test("Board create examples contain no dangling references", () => {
  const schema = BoardCreateInputSchema.omit({ path: true, mutationId: true });
  for (const key of BOARD_EXAMPLE_KEYS.filter((value) => value.startsWith("create:"))) {
    const [, type] = key.split(":");
    const seed = schema.parse(boardExample("create", type));
    const itemIds = new Set((seed.items ?? []).map((item) => item.id));
    const effectIds = new Set((seed.effects ?? []).map((effect) => effect.id));
    for (const connection of seed.connections ?? []) {
      assert.ok(itemIds.has(connection.source.itemId), `${key}: ${connection.source.itemId}`);
      assert.ok(itemIds.has(connection.target.itemId), `${key}: ${connection.target.itemId}`);
    }
    for (const effect of seed.effects ?? []) {
      if (effect.target.type === "item") assert.ok(itemIds.has(effect.target.itemId), `${key}: ${effect.target.itemId}`);
    }
    for (const composition of seed.compositions ?? []) {
      for (const target of [
        ...composition.timeline.tracks.map((track) => track.target),
        ...composition.timeline.clips.map((clip) => clip.target),
      ]) {
        if (target.type === "item") assert.ok(itemIds.has(target.itemId), `${key}: ${target.itemId}`);
        if (target.type === "effect") assert.ok(effectIds.has(target.effectId), `${key}: ${target.effectId}`);
      }
    }
  }
});

test("Board example commands list and print templates", async () => {
  const boards = new Command("boards");
  registerBoardExampleCommands(boards);
  const output: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => output.push(String(value));
  try {
    await boards.parseAsync(["examples", "--list"], { from: "user" });
    assert.deepEqual(JSON.parse(output.pop() as string), BOARD_EXAMPLE_KEYS);
    await boards.parseAsync(["examples", "create", "workflow"], { from: "user" });
    const workflow = JSON.parse(output.pop() as string) as { items: Array<{ id: string }> };
    assert.deepEqual(workflow.items.map((item) => item.id), ["request", "agent", "result"]);
    await boards.parseAsync(["examples", "batch", "basic"], { from: "user" });
    const batch = JSON.parse(output.pop() as string) as { commands: unknown[] };
    assert.equal(batch.commands.length, 2);
  } finally {
    console.log = original;
  }
});

test("Board batches validate semantic commands without rewriting payload data", () => {
  const commands = parseBatchCommands({
    commands: [{ type: "board.patch", patch: { title: "Updated" } }],
  });
  assert.deepEqual(commands, [{ type: "board.patch", patch: { title: "Updated" } }]);
  assert.throws(() => parseBatchCommands({ commands: [] }), /non-empty commands/);
  assert.throws(() => parseBatchCommands({ commands: [{ type: "unknown" }] }), /commands\[0\]/);
});

test("Board creation output includes the file entry point", () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => output.push(String(value));
  try {
    showCreated({ board: { id: "board-1", title: "Launch plan", version: 0 } }, "plans/launch.board");
  } finally {
    console.log = original;
  }
  assert.match(output.join("\n"), /plans\/launch\.board/);
  assert.match(output.join("\n"), /board-1/);
});

test("Board JSON and inspect inputs are parsed without rewriting payload data", () => {
  const value = parseJsonObject('{"nodes":[{"type":"custom.node","data":{"raw":true}}]}');
  assert.deepEqual(value, {
    nodes: [{ type: "custom.node", data: { raw: true } }],
  });
  assert.deepEqual(parseViewport("-10,20,1280,720"), {
    x: -10,
    y: 20,
    width: 1280,
    height: 720,
  });
  assert.throws(() => parseJsonObject("[]"), /JSON object/);
  assert.throws(() => parseViewport("0,0,0,100"), /greater than zero/);
  assert.throws(() => parseViewport("0,0,,100"), /finite number/);
});
