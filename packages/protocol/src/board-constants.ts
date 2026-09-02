export type BoardCoordinateSpace =
  | "world"
  | "frame-local"
  | "world-offset"
  | "screen"
  | "screen-offset"
  | "normalized";

export type BoardRenderCost = {
  particles: number;
  vertices: number;
  dynamicVertices: number;
  drawCalls: number;
  filterPasses: number;
  renderTexturePixels: number;
  textureBytes: number;
  bufferBytes: number;
  simulationSteps: number;
};

export type BoardCapability = {
  kind: "preset" | "clip" | "effect" | "shader";
  id: string;
  version: number;
  digest?: string;
  renderers?: Array<"webgpu" | "webgl">;
  fallbackId?: string;
  schema?: Record<string, unknown>;
};

export const DEFAULT_BOARD_RENDER_LIMITS: BoardRenderCost = {
  particles: 20_000,
  vertices: 500_000,
  dynamicVertices: 150_000,
  drawCalls: 400,
  filterPasses: 24,
  renderTexturePixels: 16_777_216,
  textureBytes: 512 * 1024 * 1024,
  bufferBytes: 256 * 1024 * 1024,
  simulationSteps: 100_000,
};

export const BOARD_BUILTIN_CLIP_KINDS = [
  "motion.path",
  "draw.reveal",
  "text.reveal",
  "effects.particles",
  "effects.trail",
  "effects.impact",
  "effects.flash",
  "camera.focus",
  "camera.shake",
] as const;

export const BOARD_BUILTIN_EFFECT_KINDS = [
  "effects.pulse",
  "effects.float",
] as const;

/**
 * World-space typography for board text.
 *
 * These live here rather than beside the renderer because the document schema
 * constrains persisted font sizes with them, and the schema must not depend on
 * anything that draws.
 */
export const BOARD_TEXT_FONT_FAMILY = "Geist";
export const BOARD_TEXT_FONT_SIZE = 24;
export const BOARD_TEXT_LINE_HEIGHT = 32;
export const BOARD_TEXT_MIN_FONT_SIZE = 2;
export const BOARD_TEXT_MAX_FONT_SIZE = 512;
export const BOARD_DRAW_STROKE_SIZE = 4;
export const BOARD_ARROW_STROKE_SIZE = 2.5;
export const BOARD_CONNECTION_STROKE_SIZE = 2.5;

/** Maximum encoded animation patch size for one realtime Board event. */
export const BOARD_ANIMATION_PATCH_MAX_BYTES = 16 * 1024;

/**
 * Stroke width bounds, shared by every stroked board entity.
 *
 * Defined here (not beside the editor) because the persisted schemas clamp with
 * them: a single range is what keeps a width authored by the editor, an agent or
 * the CLI from being silently re-clamped to something else on read.
 */
export const BOARD_STROKE_MIN_SIZE = 1;
export const BOARD_STROKE_MAX_SIZE = 64;

export function clampBoardStrokeSize(size: number): number {
  if (!Number.isFinite(size)) return BOARD_CONNECTION_STROKE_SIZE;
  return Math.min(BOARD_STROKE_MAX_SIZE, Math.max(BOARD_STROKE_MIN_SIZE, size));
}

/**
 * Font stacks used by every board renderer.
 *
 * A bare "Geist" would render CJK (and anything else outside the Latin subset)
 * as missing-glyph boxes, because the shipped webfont is Latin-only. The stack
 * mirrors the web `--font-sans` / `--font-mono` tokens and adds the common CJK
 * families, so both the browser and a headless export fall back to a real face
 * instead of tofu.
 */
export const BOARD_FONT_STACK =
  '"Geist", system-ui, -apple-system, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const BOARD_MONO_FONT_STACK =
  '"Geist Mono", "Fira Code", ui-monospace, "Noto Sans Mono CJK SC", monospace';

function clipSchema(id: (typeof BOARD_BUILTIN_CLIP_KINDS)[number]) {
  switch (id) {
    case "motion.path":
      return { params: { points: { coordinateSpace: "world-offset", unit: "board" } } };
    case "effects.particles":
      return { params: { bounds: { coordinateSpace: "world", unit: "board" } } };
    case "camera.focus":
      return {
        params: {
          focus: { coordinateSpace: "world", unit: "board" },
          padding: { coordinateSpace: "screen", unit: "css-px" },
          minZoom: { unit: "ratio" },
          maxZoom: { unit: "ratio" },
        },
      };
    case "camera.shake":
      return { params: { amount: { coordinateSpace: "screen-offset", unit: "css-px" } } };
    default:
      return undefined;
  }
}

export const BOARD_BUILTIN_CAPABILITIES: BoardCapability[] = [
  ...BOARD_BUILTIN_CLIP_KINDS.map((id) => {
    const schema = clipSchema(id);
    return {
      kind: "clip" as const,
      id,
      version: 1,
      renderers: ["webgpu", "webgl"] as Array<"webgpu" | "webgl">,
      ...(schema ? { schema } : {}),
    };
  }),
  ...BOARD_BUILTIN_EFFECT_KINDS.map((id) => ({
    kind: "effect" as const,
    id,
    version: 1,
    renderers: ["webgpu", "webgl"] as Array<"webgpu" | "webgl">,
  })),
];
