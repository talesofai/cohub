import type { Command } from "commander";
import { createClient } from "../client.js";
import { table, json as outJson, jsonRequested, handleHttp } from "../output.js";

export function registerSkills(program: Command): void {
  const cmd = program.command("skills").description("Skill management");

  cmd
    .command("ls")
    .alias("list")
    .description("List skills available for slash commands")
    .option("--space <id>", "Filter by space")
    .option("--json", "Output as JSON")
    .action(async (opts: { space?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const spaceId = opts.space ?? (program.opts() as { space?: string }).space;
        const result = await client.skills.list({ spaceId });
        if (jsonRequested(opts)) return outJson(result);
        if (result.skills.length === 0) return console.log("  (empty)");
        table(
          result.skills.map((skill) => ({
            command: `/skill:${skill.name}`,
            source: skill.source?.type === "mod" ? `mod:${skill.source.mountSlug}` : skill.scope,
            description: skill.description,
          })),
          [
            { key: "command", label: "Command" },
            { key: "source", label: "Source" },
            { key: "description", label: "Description" },
          ],
        );
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
