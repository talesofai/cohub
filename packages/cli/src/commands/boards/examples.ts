import type { Command } from "commander";
import { json } from "../../output.js";

const templates: Record<string, unknown> = {
  "batch:basic": {
    commands: [
      { type: "board.patch", patch: { title: "Updated title" } },
      { type: "item.patch", itemId: "title", patch: { props: { text: "Updated text" } } },
    ],
  },
  "create": {
    items: [{
      id: "title",
      type: "text",
      position: { x: 120, y: 80 },
      size: { width: 320, height: 48 },
      rotation: 0,
      props: { text: "Launch plan", fontSize: 32 },
      style: { color: "brand" },
    }],
    connections: [],
    effects: [],
    compositions: [],
  },
  "create:workflow": {
    items: [
      {
        id: "request",
        type: "text",
        position: { x: 80, y: 190 },
        size: { width: 180, height: 48 },
        rotation: 0,
        props: { text: "Request", fontSize: 28 },
        style: { color: "brand" },
      },
      {
        id: "agent",
        type: "geo",
        position: { x: 360, y: 150 },
        size: { width: 240, height: 120 },
        rotation: 0,
        props: { shape: "rounded", text: "Agent" },
        style: { color: "blue", fillOpacity: 0.08 },
      },
      {
        id: "result",
        type: "geo",
        position: { x: 700, y: 150 },
        size: { width: 240, height: 120 },
        rotation: 0,
        props: { shape: "rounded", text: "Result" },
        style: { color: "green", fillOpacity: 0.08 },
      },
    ],
    connections: [
      { id: "request-agent", source: { itemId: "request" }, target: { itemId: "agent" }, relation: "triggers", label: "invoke" },
      { id: "agent-result", source: { itemId: "agent" }, target: { itemId: "result" }, relation: "produces", label: "output" },
    ],
    effects: [],
    compositions: [],
  },
  "create:media": {
    items: [
      {
        id: "hero",
        type: "image",
        position: { x: 80, y: 100 },
        size: { width: 640, height: 360 },
        rotation: 0,
        source: { kind: "space-file", path: "assets/hero.webp" },
        props: {},
      },
      {
        id: "demo-video",
        type: "video",
        position: { x: 760, y: 100 },
        size: { width: 480, height: 270 },
        rotation: 0,
        source: { kind: "space-file", path: "assets/demo.mp4" },
        props: {},
      },
      {
        id: "soundtrack",
        type: "audio",
        position: { x: 80, y: 500 },
        size: { width: 400, height: 96 },
        rotation: 0,
        source: { kind: "space-file", path: "assets/soundtrack.mp3" },
        props: {},
      },
      {
        id: "brief",
        type: "file",
        position: { x: 520, y: 500 },
        size: { width: 320, height: 180 },
        rotation: 0,
        source: { kind: "space-file", path: "docs/brief.md" },
        props: {},
      },
    ],
    connections: [],
    effects: [],
    compositions: [],
  },
  "create:animation": {
    items: [
      {
        id: "title",
        type: "text",
        position: { x: 120, y: 80 },
        size: { width: 320, height: 48 },
        rotation: 0,
        props: { text: "Launch", fontSize: 32 },
        style: { color: "brand" },
      },
      {
        id: "stroke",
        type: "draw",
        rotation: 0,
        props: { points: [{ x: 2, y: 98, p: 0.5 }, { x: 90, y: 2, p: 0.5 }, { x: 178, y: 98, p: 0.5 }] },
        style: { color: "violet", strokeWidth: 4 },
      },
    ],
    connections: [],
    effects: [{
      id: "pulse-title",
      target: { type: "item", itemId: "title" },
      kind: "effects.pulse",
      kindVersion: 1,
      lifecycle: "when-visible",
      timeOrigin: "visible",
      seed: "pulse-title",
      params: { amount: 0.04, period: 1600 },
    }],
    compositions: [
      {
        id: "intro",
        name: "Intro",
        timeline: {
          duration: 800,
          tracks: [{
            id: "title-opacity",
            target: { type: "item", itemId: "title" },
            channel: "style.opacity",
            fill: "both",
            keyframes: [{ time: 0, value: 0 }, { time: 800, value: 1, easing: "ease-out-cubic" }],
          }],
        },
      },
      {
        id: "draw-stroke",
        name: "Draw stroke",
        timeline: {
          duration: 900,
          clips: [{
            id: "reveal-stroke",
            kind: "draw.reveal",
            kindVersion: 1,
            target: { type: "item", itemId: "stroke" },
            start: 0,
            duration: 900,
            easing: "ease-out-cubic",
            seed: "reveal-stroke",
          }],
        },
      },
    ],
  },
  "item:text": {
    id: "title",
    type: "text",
    position: { x: 120, y: 80 },
    size: { width: 320, height: 48 },
    rotation: 0,
    props: { text: "Launch plan", fontSize: 32 },
    style: { color: "brand" },
  },
  "item:image": {
    id: "hero",
    type: "image",
    position: { x: 120, y: 160 },
    size: { width: 640, height: 360 },
    rotation: 0,
    source: { kind: "space-file", path: "assets/hero.webp" },
    props: {},
  },
  "item:geo": {
    id: "goal",
    type: "geo",
    position: { x: 120, y: 160 },
    size: { width: 280, height: 140 },
    rotation: 0,
    props: { shape: "rounded", text: "Ship" },
    style: { color: "green", fillOpacity: 0.12 },
  },
  "item:frame": {
    id: "scene",
    type: "frame",
    position: { x: 80, y: 60 },
    size: { width: 960, height: 540 },
    rotation: 0,
    props: { label: "Scene 1" },
    style: { color: "neutral" },
  },
  "item:draw": {
    id: "stroke",
    type: "draw",
    rotation: 0,
    props: { points: [{ x: 102, y: 198, p: 0.5 }, { x: 190, y: 102, p: 0.5 }, { x: 278, y: 198, p: 0.5 }] },
    style: { color: "violet", strokeWidth: 4 },
  },
  "item:arrow": {
    id: "arrow",
    type: "arrow",
    rotation: 0,
    props: { start: { x: 116, y: 150 }, end: { x: 344, y: 150 }, bend: 0, arrowStart: false, arrowEnd: true, label: "next" },
    style: { color: "brand", strokeWidth: 2.5 },
  },
  "item:video": {
    id: "demo-video",
    type: "video",
    position: { x: 120, y: 160 },
    size: { width: 640, height: 360 },
    rotation: 0,
    source: { kind: "space-file", path: "assets/demo.mp4" },
    props: {},
  },
  "item:audio": {
    id: "soundtrack",
    type: "audio",
    position: { x: 120, y: 540 },
    size: { width: 480, height: 96 },
    rotation: 0,
    source: { kind: "space-file", path: "assets/soundtrack.mp3" },
    props: {},
  },
  "item:file": {
    id: "brief",
    type: "file",
    position: { x: 120, y: 160 },
    size: { width: 360, height: 220 },
    rotation: 0,
    source: { kind: "space-file", path: "docs/brief.md" },
    props: {},
  },
  "item:task": {
    id: "task",
    type: "task",
    position: { x: 120, y: 160 },
    size: { width: 420, height: 240 },
    rotation: 0,
    props: { taskRunId: "task-run-id", snapshot: { taskType: "generation", status: "running", title: "Generate concept", artifactCount: 0, artifacts: [] } },
  },
  "effect:pulse": {
    id: "pulse-title",
    target: { type: "item", itemId: "title" },
    kind: "effects.pulse",
    kindVersion: 1,
    lifecycle: "when-visible",
    timeOrigin: "visible",
    seed: "pulse-title",
    params: { amount: 0.04, period: 1600 },
  },
  "effect:float": {
    id: "float-hero",
    target: { type: "item", itemId: "hero" },
    kind: "effects.float",
    kindVersion: 1,
    lifecycle: "when-visible",
    timeOrigin: "visible",
    seed: "float-hero",
    params: { distance: 8, period: 2200 },
  },
  "composition:fade": {
    id: "intro",
    name: "Intro",
    timeline: {
      duration: 800,
      tracks: [{
        id: "title-opacity",
        target: { type: "item", itemId: "title" },
        channel: "style.opacity",
        fill: "both",
        keyframes: [
          { time: 0, value: 0 },
          { time: 800, value: 1, easing: "ease-out-cubic" },
        ],
      }],
    },
  },
  "composition:reveal": {
    id: "reveal",
    name: "Reveal",
    timeline: {
      duration: 600,
      clips: [{ id: "reveal-title", kind: "text.reveal", kindVersion: 1, target: { type: "item", itemId: "title" }, start: 0, duration: 600, fill: "both", easing: "ease-out-cubic", params: { mode: "words" }, seed: "reveal-title" }],
    },
  },
  "composition:motion-path": {
    id: "motion",
    name: "Motion path",
    timeline: {
      duration: 1200,
      clips: [{ id: "move-hero", kind: "motion.path", kindVersion: 1, target: { type: "item", itemId: "hero" }, start: 0, duration: 1200, fill: "both", easing: "ease-in-out-cubic", params: { points: [{ x: 0, y: 0 }, { x: 160, y: -40 }, { x: 320, y: 0 }], orient: true }, seed: "move-hero" }],
    },
  },
  "composition:draw-reveal": {
    id: "draw-stroke",
    name: "Draw stroke",
    timeline: {
      duration: 900,
      clips: [{ id: "reveal-stroke", kind: "draw.reveal", kindVersion: 1, target: { type: "item", itemId: "stroke" }, start: 0, duration: 900, easing: "ease-out-cubic", seed: "reveal-stroke" }],
    },
  },
  "composition:trail": {
    id: "move-with-trail",
    name: "Move with trail",
    timeline: {
      duration: 1200,
      clips: [
        { id: "move-hero", kind: "motion.path", kindVersion: 1, target: { type: "item", itemId: "hero" }, start: 0, duration: 1200, easing: "ease-in-out-cubic", fill: "both", params: { points: [{ x: 0, y: 0 }, { x: 320, y: 0 }] }, seed: "move-hero" },
        { id: "trail-hero", kind: "effects.trail", kindVersion: 1, target: { type: "item", itemId: "hero" }, start: 0, duration: 1200, params: { alpha: 0.48 }, seed: "trail-hero" },
      ],
    },
  },
  "composition:impact": {
    id: "impact",
    name: "Impact",
    timeline: {
      duration: 500,
      clips: [{ id: "impact-ring", kind: "effects.impact", kindVersion: 1, target: { type: "board" }, start: 0, duration: 500, layer: "front", params: { center: { x: 400, y: 300 }, radius: 120 }, seed: "impact-ring" }],
    },
  },
  "composition:flash": {
    id: "flash",
    name: "Flash",
    timeline: {
      duration: 300,
      clips: [{ id: "screen-flash", kind: "effects.flash", kindVersion: 1, target: { type: "board" }, start: 0, duration: 300, layer: "screen", params: { alpha: 0.3 }, seed: "screen-flash" }],
    },
  },
  "composition:particles": {
    id: "celebrate",
    name: "Celebrate",
    timeline: {
      duration: 1000,
      clips: [{ id: "particles", kind: "effects.particles", kindVersion: 1, target: { type: "board" }, start: 0, duration: 1000, layer: "front", params: { count: 420, bounds: { x: 0, y: 0, width: 800, height: 600 } }, seed: "particles" }],
    },
    playback: { endBehavior: "reset" },
  },
  "composition:camera-shake": {
    id: "shake",
    name: "Camera shake",
    timeline: {
      duration: 500,
      clips: [{ id: "shake-camera", kind: "camera.shake", kindVersion: 1, target: { type: "camera" }, start: 0, duration: 500, layer: "screen", params: { amount: 8, frequency: 28 }, seed: "shake-camera" }],
    },
  },
  "composition:camera-focus": {
    id: "tour",
    name: "Tour",
    timeline: {
      duration: 1000,
      clips: [{
        id: "focus-title",
        kind: "camera.focus",
        kindVersion: 1,
        target: { type: "camera" },
        start: 0,
        duration: 700,
        layer: "screen",
        fill: "forwards",
        easing: "ease-out-cubic",
        params: { focus: { type: "item", itemId: "title" }, fit: "contain", padding: 32 },
        seed: "focus-title",
      }],
    },
  },
};

export const BOARD_EXAMPLE_KEYS = Object.keys(templates);

export function boardExample(kind: string, type?: string): unknown {
  const key = type ? `${kind}:${type}` : kind;
  const template = templates[key];
  if (!template) throw new Error(`Unknown Board example: ${key}`);
  return template;
}

export function registerBoardExampleCommands(boards: Command): void {
  boards.command("examples [kind] [type]")
    .description("Print editable semantic JSON templates")
    .option("--list", "List available examples")
    .addHelpText("after", `
Kinds:
  create [workflow|media|animation]
  batch basic
  item text|image|video|audio|file|task|geo|frame|draw|arrow
  effect pulse|float
  composition fade|reveal|draw-reveal|motion-path|trail|impact|flash|particles|camera-shake|camera-focus

Examples:
  cohub boards examples --list
  cohub boards examples create workflow > board.json
  cohub boards examples batch basic > changes.json
  cohub boards examples item text > item.json
  cohub boards examples composition fade > intro.json`)
    .action((kind: string | undefined, type: string | undefined, options: { list?: boolean }) => {
      if (options.list) return json(BOARD_EXAMPLE_KEYS);
      if (!kind) throw new Error("Example kind is required. Use --list to see available examples.");
      json(boardExample(kind, type));
    });
}
