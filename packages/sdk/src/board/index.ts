/**
 * Board document model.
 *
 * The persisted schema, world-space geometry, the shape layer and the animation
 * timeline — everything that describes a board without drawing one. It carries
 * no renderer and no PixiJS, so agents, servers and edge workers can read and
 * write boards without a graphics stack. Drawing lives in `./render`, and image
 * export in `./export` and `./headless`.
 */

export * from "./animation.js";
export {
	BoardCameraFocusParamsSchema,
	BoardCameraFocusSchema,
	BoardCameraStateSchema,
	isBoardPath,
	parseBoardManifest,
	serializeBoardManifest,
	type BoardCameraFocus,
	type BoardCameraFocusParams,
	type BoardCameraState,
} from "@cohub/protocol";
export * from "@cohub/protocol/board-connection";
export * from "@cohub/protocol/board-document";
export * from "./semantic-document.js";
export * from "./core/arrow-geometry.js";
export { boardArrowFrame as computeArrowFrame } from "@cohub/protocol";
export * from "./core/connections.js";
export * from "./core/draw-geometry.js";
export * from "./core/export-assets.js";
export * from "./core/export-plan.js";
export * from "./core/file-preview.js";
export * from "./core/palette.js";
export * from "./core/shape-definition.js";
// `ArrowEndpoint` and `DrawPoint` also exist on the document schema; the schema
// is the persisted shape, so it wins and the shape-layer aliases stay internal.
export {
	FULL_CAPABILITIES,
	GEO_KINDS,
	type ArrowShapeProps,
	type AudioShapeProps,
	type DrawShapeProps,
	type GeoKind,
	type GeoShapeProps,
	type HandleDragResult,
	type ImageShapeProps,
	type ShapeCapabilities,
	type ShapeGeometry,
	type ShapeHandle,
	type ShapeHandleId,
	type ShapeResizeMode,
	type TextShapeProps,
	type VideoShapeProps,
	isGeoKind,
	resizeModeForCapabilities,
} from "./core/shape-types.js";
export * from "./core/text-metrics.js";
export * from "./core/tool-styles.js";
export * from "./geometry.js";
export * from "./image-key.js";
export * from "./media.js";
export * from "./media-playback.js";
export * from "./mutation.js";
export * from "./semantic-mutation.js";
export * from "./task.js";
