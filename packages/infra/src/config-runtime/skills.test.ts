import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindModSkillsConfig,
  bindSpaceModSkillsConfig,
  mergeSkillsConfigs,
  toSkillCatalog,
  type Skill,
} from "./skills.js";

function createSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "example",
    description: "Example skill",
    content: "---\nname: example\n---\nExample",
    filePath: "/cache/mod/.agents/skills/example/SKILL.md",
    sandboxFilePath: "/mods/old/.agents/skills/example/SKILL.md",
    baseDir: "/cache/mod/.agents/skills/example",
    sandboxBaseDir: "/mods/old/.agents/skills/example",
    scope: "mod",
    disableModelInvocation: false,
    ...overrides,
  };
}

test("bindModSkillsConfig binds provenance and current mount paths", () => {
  const bound = bindModSkillsConfig(
    { skills: [createSkill()] },
    {
      skillsDir: "/cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  );

  assert.deepEqual(bound.skills[0]?.source, {
    type: "mod",
    modSpaceId: "mod-space-id",
    mountSlug: "current",
  });
  assert.equal(bound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
  assert.equal(bound.skills[0]?.sandboxBaseDir, "/mods/current/.agents/skills/example");
});

test("bindModSkillsConfig rebases cache entries created under another host root", () => {
  const bound = bindModSkillsConfig(
    { skills: [createSkill()] },
    {
      skillsDir: "/worker-cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  );

  assert.equal(bound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
  assert.equal(bound.skills[0]?.sandboxBaseDir, "/mods/current/.agents/skills/example");
});

test("bindSpaceModSkillsConfig validates and rebinds aggregate cache entries", () => {
  const rebound = bindSpaceModSkillsConfig(
    {
      skills: [createSkill({
        source: {
          type: "mod",
          modSpaceId: "mod-space-id",
          mountSlug: "current",
        },
      })],
    },
    [{
      skillsDir: "/worker-cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    }],
  );

  assert.equal(rebound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
});

test("toSkillCatalog preserves mod provenance", () => {
  const [entry] = toSkillCatalog([
    createSkill({
      source: {
        type: "mod",
        modSpaceId: "mod-space-id",
        mountSlug: "current",
      },
    }),
  ]);

  assert.deepEqual(entry, {
    name: "example",
    description: "Example skill",
    scope: "mod",
    source: {
      type: "mod",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  });
});

test("mergeSkillsConfigs keeps the source of the effective skill", () => {
  const merged = mergeSkillsConfigs(
    {
      skills: [createSkill({ source: { type: "mod", modSpaceId: "first", mountSlug: "first" } })],
    },
    {
      skills: [createSkill({ source: { type: "mod", modSpaceId: "second", mountSlug: "second" } })],
    },
  );

  assert.equal(merged.skills[0]?.source?.modSpaceId, "second");
  assert.equal(merged.skills[0]?.source?.mountSlug, "second");
});

test("bindModSkillsConfig rejects paths outside the cached mod directory", () => {
  const binding = {
    skillsDir: "/cache/mod/.agents/skills",
    sandboxDir: "/mods/current/.agents/skills",
    modSpaceId: "mod-space-id",
    mountSlug: "current",
  };

  assert.throws(
    () => bindModSkillsConfig(
      { skills: [createSkill({ filePath: "/cache/other/SKILL.md" })] },
      binding,
    ),
    /outside its source directory/,
  );
  assert.throws(
    () => bindModSkillsConfig(
      {
        skills: [createSkill({
          filePath: "/other-root/.agents/skills/example/../../../../workspace/secret",
        })],
      },
      binding,
    ),
    /outside its source directory/,
  );
});
