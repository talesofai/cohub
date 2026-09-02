/**
 * PixiJS rendering for boards.
 *
 * The card renderers, the theme backgrounds and the text machinery that needs a
 * real canvas all live behind this entry, so `@neta-art/cohub/board` can stay a
 * pure model that runs without PixiJS. The browser editor and headless exporter
 * share the same Board geometry and semantics, while each backend uses a
 * compatible drawing primitive.
 */

export * from "./connection-layer.js";
export * from "./css-color.js";
export * from "./media-interaction.js";
export * from "./palette.js";
export * from "./renderers/board-renderer-registry.js";
export { TASK_CARD_FULL_DETAIL_ZOOM } from "./renderers/task-card-renderer.js";
export * from "./text-measurement.js";
export * from "./text-resolution.js";
export * from "./themes/board-theme-registry.js";
export * from "./video-thumbnail.js";
