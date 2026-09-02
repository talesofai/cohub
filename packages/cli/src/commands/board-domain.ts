import type { Command } from "commander";
import { registerBoardAnimationCommands } from "./boards/animation.js";
import { registerBoardAppearanceCommands } from "./boards/appearance.js";
import { registerBoardExampleCommands } from "./boards/examples.js";
import { registerBoardBatchCommand } from "./boards/batch.js";
import { registerBoardConnectionCommands } from "./boards/connections.js";
import { registerBoardItemCommands } from "./boards/items.js";

export function registerBoardDomainCommands(boards: Command): void {
  registerBoardExampleCommands(boards);
  registerBoardAppearanceCommands(boards);
  registerBoardBatchCommand(boards);
  registerBoardConnectionCommands(boards);
  registerBoardItemCommands(boards);
  registerBoardAnimationCommands(boards);
}
