import type {
	BoardComposition,
	BoardEffectInput,
	BoardPlaybackSnapshot,
	BoardProceduralClip,
} from "@neta-art/cohub";
import type {
	BoardCameraFocusParams,
	BoardItem,
	BoardViewport,
} from "@neta-art/cohub/board";
import {
	BoardCameraFocusParamsSchema,
	buildStrokeRibbonGeometry,
	cameraForFocus,
} from "@neta-art/cohub/board";
import {
	Container,
	Graphics,
	Mesh,
	MeshGeometry,
	MeshRope,
	Particle,
	ParticleContainer,
	Point,
	Rectangle,
	Shader,
	Texture,
	UniformGroup,
} from "pixi.js";
import {
	type AnimationPose,
	clipSampleAt,
	composePose,
	compositionItemPoses,
	compositionItemTargetIds,
	createPose,
	hashUnit,
	playbackSampleAt,
	samplePathPose,
	timelinePosition,
} from "$lib/board/runtime/animation-core";
import type { BoardRuntimeData } from "$lib/board/runtime/board-runtime";

type BasePose = {
	x: number;
	y: number;
	scaleX: number;
	scaleY: number;
	rotation: number;
	alpha: number;
};

type RuntimeNode = {
	item: BoardItem;
	container: Container;
};

type RuntimeOptions = {
	getNode: (nodeId: string) => RuntimeNode | null;
	getItem?: (nodeId: string) => BoardItem | null;
	getGeometryVersion?: () => number;
	getWorld: () => Container | null;
	getLayers: () => {
		behind: Container;
		front: Container;
		screen: Container;
	} | null;
	getScreen: () => { width: number; height: number };
	getAccentColor: () => number;
	render: () => void;
};

type ParticleResource = {
	container: ParticleContainer;
	particles: Particle[];
	indexes: number[];
};

type TrailResource = {
	rope: MeshRope;
	points: Point[];
};

type RevealResource = {
	mesh: Mesh<MeshGeometry, Shader>;
	shader: Shader;
	geometry: MeshGeometry;
	original: Container;
	originalRenderable: boolean;
};

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function poseOf(node: Container): BasePose {
	return {
		x: node.x,
		y: node.y,
		scaleX: node.scale.x,
		scaleY: node.scale.y,
		rotation: node.rotation,
		alpha: node.alpha,
	};
}

function restore(node: Container, pose: BasePose) {
	node.position.set(pose.x, pose.y);
	node.scale.set(pose.scaleX, pose.scaleY);
	node.rotation = pose.rotation;
	node.alpha = pose.alpha;
}

function applyPose(node: Container, base: BasePose, pose: AnimationPose) {
	node.position.set(base.x + pose.x, base.y + pose.y);
	node.scale.set(base.scaleX * pose.scaleX, base.scaleY * pose.scaleY);
	node.rotation = base.rotation + pose.rotation;
	node.alpha = Math.max(0, Math.min(1, base.alpha * pose.alpha));
}

export type PreparedCameraFocusClip = {
	clip: BoardProceduralClip;
	params: BoardCameraFocusParams;
	previousForwardIndex: number | null;
};

export function prepareCameraFocusClips(
	compositions: BoardComposition[],
): Map<string, PreparedCameraFocusClip[]> {
	const result = new Map<string, PreparedCameraFocusClip[]>();
	for (const composition of compositions) {
		for (const clip of composition.timeline.clips) {
			if (clip.kind !== "camera.focus") continue;
			const parsed = BoardCameraFocusParamsSchema.safeParse(clip.params);
			if (!parsed.success) continue;
			const entries = result.get(composition.id) ?? [];
			entries.push({ clip, params: parsed.data, previousForwardIndex: null });
			result.set(composition.id, entries);
		}
	}
	for (const entries of result.values()) {
		entries.sort(
			(left, right) =>
				left.clip.start - right.clip.start ||
				left.clip.id.localeCompare(right.clip.id),
		);
		let previousForwardIndex: number | null = null;
		for (const [index, entry] of entries.entries()) {
			entry.previousForwardIndex = previousForwardIndex;
			if (entry.clip.fill === "forwards" || entry.clip.fill === "both") {
				previousForwardIndex = index;
			}
		}
	}
	return result;
}

export function resolveCameraFocusPose(input: {
	clips: PreparedCameraFocusClip[];
	position: number;
	base: BoardViewport;
	resolveTarget: (entry: PreparedCameraFocusClip) => BoardViewport | null;
}): AnimationPose | null {
	if (input.clips.length === 0) return null;
	let low = 0;
	let high = input.clips.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (
			(input.clips[middle]?.clip.start ?? Number.POSITIVE_INFINITY) <=
			input.position
		)
			low = middle + 1;
		else high = middle;
	}
	const index = low - 1;
	if (index < 0) return null;
	const entry = input.clips[index];
	if (!entry) return null;
	const resolvePrevious = () =>
		entry.previousForwardIndex === null
			? null
			: input.resolveTarget(input.clips[entry.previousForwardIndex]);
	const end = entry.clip.start + entry.clip.duration;
	let current: BoardViewport | null = null;
	if (input.position <= end) {
		const previous = resolvePrevious();
		const target = input.resolveTarget(entry);
		if (!target) current = previous;
		else {
			const from = previous ?? input.base;
			const progress = clipSampleAt(entry.clip, input.position)?.progress ?? 0;
			current = {
				x: from.x + (target.x - from.x) * progress,
				y: from.y + (target.y - from.y) * progress,
				zoom: from.zoom + (target.zoom - from.zoom) * progress,
			};
		}
	} else if (entry.clip.fill === "forwards" || entry.clip.fill === "both") {
		current = input.resolveTarget(entry);
	} else {
		current = resolvePrevious();
	}
	return current
		? {
				x: current.x - input.base.x,
				y: current.y - input.base.y,
				scaleX: current.zoom / input.base.zoom,
				scaleY: current.zoom / input.base.zoom,
				rotation: 0,
				alpha: 1,
			}
		: null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundsParam(value: unknown): Rectangle {
	const bounds = record(value);
	return new Rectangle(
		finite(bounds?.x) ? bounds.x : -256,
		finite(bounds?.y) ? bounds.y : -256,
		finite(bounds?.width) ? Math.max(1, bounds.width) : 512,
		finite(bounds?.height) ? Math.max(1, bounds.height) : 512,
	);
}

function layerForClip(
	clip: BoardProceduralClip,
	layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
): Container {
	if (clip.layer === "screen") return layers.screen;
	if (clip.layer === "behind") return layers.behind;
	return layers.front;
}

const REVEAL_VERTEX_GL = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
in float aProgress;
out float vProgress;
out vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
void main(void) {
  mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((matrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vProgress = aProgress;
  vColor = uColor * uWorldColorAlpha;
}`;

const REVEAL_FRAGMENT_GL = `#version 300 es
precision highp float;
in float vProgress;
in vec4 vColor;
out vec4 finalColor;
uniform float uProgress;
uniform float uSoftness;
void main(void) {
  float revealed = 1.0 - smoothstep(uProgress, uProgress + uSoftness, vProgress);
  finalColor = vec4(vColor.rgb, vColor.a * revealed);
}`;

const REVEAL_WGSL = `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct RevealUniforms {
  uProgress: f32,
  uSoftness: f32,
  padding0: f32,
  padding1: f32,
}
@group(2) @binding(0) var<uniform> revealUniforms: RevealUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) progress: f32,
  @location(1) color: vec4<f32>,
}

@vertex
fn mainVertex(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
  @location(2) aProgress: f32,
) -> VertexOutput {
  var output: VertexOutput;
  let matrix = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  output.position = vec4<f32>((matrix * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  output.progress = aProgress;
  output.color = localUniforms.uColor * globalUniforms.uWorldColorAlpha;
  return output;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let revealed = 1.0 - smoothstep(revealUniforms.uProgress, revealUniforms.uProgress + revealUniforms.uSoftness, input.progress);
  return vec4<f32>(input.color.rgb, input.color.a * revealed);
}`;

function createRevealShader() {
	const revealUniforms = new UniformGroup({
		uProgress: { value: 0, type: "f32" },
		uSoftness: { value: 0.015, type: "f32" },
		padding0: { value: 0, type: "f32" },
		padding1: { value: 0, type: "f32" },
	});
	return Shader.from({
		gl: { vertex: REVEAL_VERTEX_GL, fragment: REVEAL_FRAGMENT_GL },
		gpu: {
			vertex: { source: REVEAL_WGSL, entryPoint: "mainVertex" },
			fragment: { source: REVEAL_WGSL, entryPoint: "mainFragment" },
		},
		resources: { revealUniforms },
	});
}

function drawRevealGeometry(item: Extract<BoardItem, { type: "draw" }>) {
	const ribbon = buildStrokeRibbonGeometry(item.points, item.size);
	if (ribbon.indices.length === 0) return null;
	const geometry = new MeshGeometry({
		positions: ribbon.positions,
		uvs: ribbon.uvs,
		indices: ribbon.indices,
	});
	geometry.batchMode = "no-batch";
	geometry.addAttribute("aProgress", {
		buffer: ribbon.progress,
		format: "float32",
	});
	return geometry;
}

function particleLimit(): number {
	const cores =
		typeof navigator === "undefined" ? 8 : navigator.hardwareConcurrency || 4;
	return cores <= 4 ? 3_000 : 10_000;
}

export function createBoardAnimationRuntime(options: RuntimeOptions) {
	let data: BoardRuntimeData = {
		boardId: "",
		effects: [],
		compositions: [],
		playback: null,
		playbackPolicy: null,
	};
	let cameraFocusBySequence = new Map<string, PreparedCameraFocusClip[]>();
	let compositionByRevision = new Map<string, BoardComposition>();
	let compositionById = new Map<string, BoardComposition>();
	let motionClipsByComposition = new Map<
		string,
		Map<string, BoardProceduralClip[]>
	>();
	let targetIdsByComposition = new Map<string, Set<string>>();
	let activeEffects: BoardRuntimeData["effects"] = [];

	const compositionKey = (
		composition: Pick<BoardComposition, "id" | "revision">,
	) => `${composition.id}:${composition.revision}`;
	const playbackComposition = (playback: BoardPlaybackSnapshot | null) =>
		playback
			? (compositionByRevision.get(
					`${playback.compositionId}:${playback.compositionRevision}`,
				) ?? null)
			: null;
	function rebuildRuntimeIndexes(next: BoardRuntimeData) {
		compositionByRevision = new Map();
		compositionById = new Map();
		motionClipsByComposition = new Map();
		targetIdsByComposition = new Map();
		for (const composition of next.compositions) {
			const key = compositionKey(composition);
			compositionByRevision.set(key, composition as BoardComposition);
			compositionById.set(composition.id, composition as BoardComposition);
			const byItem = new Map<string, BoardProceduralClip[]>();
			for (const clip of composition.timeline.clips) {
				if (clip.kind !== "motion.path" || clip.target.type !== "item")
					continue;
				const clips = byItem.get(clip.target.itemId) ?? [];
				clips.push(clip);
				byItem.set(clip.target.itemId, clips);
			}
			motionClipsByComposition.set(key, byItem);
			targetIdsByComposition.set(
				key,
				compositionItemTargetIds(composition as BoardComposition),
			);
		}
		activeEffects = next.effects.filter(
			(effect) => effect.enabled && effect.lifecycle !== "manual",
		);
	}
	const cameraFocusTargetCache = new Map<
		string,
		{
			geometryVersion: number;
			width: number;
			height: number;
			target: BoardViewport | null;
		}
	>();
	const basePoses = new Map<string, BasePose>();
	const effectOrigins = new Map<string, number>();
	const effectVisibility = new Map<string, boolean>();
	const impactResources = new Map<string, Graphics>();
	const flashResources = new Map<
		string,
		{ graphics: Graphics; width: number; height: number }
	>();
	const particleResources = new Map<string, ParticleResource>();
	const trailResources = new Map<string, TrailResource>();
	const revealResources = new Map<string, RevealResource>();
	let worldPose: BasePose | null = null;
	let frameId = 0;
	let sharedPlayback: BoardPlaybackSnapshot | null = null;
	let autoplayKey: string | null = null;
	let autoplayPlayback: BoardPlaybackSnapshot | null = null;
	let autoplayTimer: ReturnType<typeof setTimeout> | null = null;
	let active = true;
	let destroyed = false;
	let reducedMotion = false;
	let materializationVersion = 0;
	let materializationCacheVersion = -1;
	let materializationCacheMode = "";
	let materializationCache = new Set<string>();
	const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

	function nodeWithBase(nodeId: string) {
		const entry = options.getNode(nodeId);
		if (!entry) return null;
		let base = basePoses.get(nodeId);
		if (!base) {
			base = poseOf(entry.container);
			basePoses.set(nodeId, base);
		}
		return { ...entry, base };
	}

	function restoreSceneState() {
		for (const [nodeId, pose] of basePoses) {
			const node = options.getNode(nodeId)?.container;
			if (node) restore(node, pose);
		}
		for (const graphics of impactResources.values()) graphics.visible = false;
		for (const resource of flashResources.values())
			resource.graphics.visible = false;
		for (const resource of particleResources.values())
			resource.container.visible = false;
		for (const resource of trailResources.values())
			resource.rope.visible = false;
		for (const resource of revealResources.values()) {
			resource.mesh.visible = false;
			resource.original.renderable = resource.originalRenderable;
		}
	}

	function restoreAll() {
		restoreSceneState();
		const world = options.getWorld();
		if (world && worldPose) restore(world, worldPose);
	}

	function clearResources() {
		restoreAll();
		for (const graphics of impactResources.values()) graphics.destroy();
		for (const resource of flashResources.values()) resource.graphics.destroy();
		for (const resource of particleResources.values())
			resource.container.destroy();
		for (const resource of trailResources.values()) resource.rope.destroy();
		for (const resource of revealResources.values()) {
			resource.mesh.destroy();
			resource.shader.destroy();
			resource.geometry.destroy();
		}
		impactResources.clear();
		flashResources.clear();
		particleResources.clear();
		trailResources.clear();
		revealResources.clear();
	}

	function poseFor(poses: Map<string, AnimationPose>, nodeId: string) {
		let pose = poses.get(nodeId);
		if (!pose) {
			pose = createPose();
			poses.set(nodeId, pose);
		}
		return pose;
	}

	function applyEffect(
		effect: BoardEffectInput & { revision: number },
		now: number,
		poses: Map<string, AnimationPose>,
	): boolean {
		if (
			!effect.enabled ||
			effect.lifecycle === "manual" ||
			effect.target.type !== "item"
		)
			return false;
		const entry = nodeWithBase(effect.target.itemId);
		if (!entry) return false;
		const visible = entry.container.visible;
		const wasVisible = effectVisibility.get(effect.id) ?? false;
		effectVisibility.set(effect.id, visible);
		if (effect.lifecycle === "when-visible" && !visible) return false;
		if (
			!effectOrigins.has(effect.id) ||
			(effect.timeOrigin === "visible" && visible && !wasVisible)
		) {
			effectOrigins.set(effect.id, now);
		}
		const origin =
			effect.timeOrigin === "board" ? 0 : (effectOrigins.get(effect.id) ?? now);
		const period = finite(effect.params.period)
			? Math.max(100, effect.params.period)
			: 1_800;
		const phase = (((now - origin) % period) / period) * Math.PI * 2;
		const pose = poseFor(poses, effect.target.itemId);
		if (effect.kind === "effects.pulse") {
			const amount = finite(effect.params.amount) ? effect.params.amount : 0.04;
			composePose(pose, { scale: 1 + Math.sin(phase) * amount });
			return true;
		}
		if (effect.kind === "effects.float") {
			const distance = finite(effect.params.distance)
				? effect.params.distance
				: 6;
			composePose(pose, { y: Math.sin(phase) * distance });
			return true;
		}
		return false;
	}

	function impactResource(
		clip: BoardProceduralClip,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	) {
		let graphics = impactResources.get(clip.id);
		if (!graphics) {
			graphics = new Graphics()
				.circle(0, 0, 1)
				.stroke({ color: 0xffffff, width: 0.08, alpha: 1 })
				.circle(0, 0, 0.62)
				.stroke({ color: 0xffffff, width: 0.05, alpha: 0.7 });
			graphics.blendMode = "add";
			layerForClip(clip, layers).addChild(graphics);
			impactResources.set(clip.id, graphics);
		}
		return graphics;
	}

	function updateImpact(
		clip: BoardProceduralClip,
		progress: number,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	) {
		const graphics = impactResource(clip, layers);
		const center = record(clip.params.center);
		const radius = finite(clip.params.radius) ? clip.params.radius : 160;
		graphics.position.set(
			finite(center?.x) ? center.x : 0,
			finite(center?.y) ? center.y : 0,
		);
		graphics.scale.set(Math.max(0.001, radius * (1 - (1 - progress) ** 3)));
		graphics.alpha = (1 - progress) ** 2;
		graphics.tint = finite(clip.params.color)
			? clip.params.color
			: options.getAccentColor();
		graphics.visible = progress < 1;
	}

	function updateFlash(
		clip: BoardProceduralClip,
		progress: number,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	) {
		let resource = flashResources.get(clip.id);
		const screen = options.getScreen();
		if (!resource) {
			resource = { graphics: new Graphics(), width: 0, height: 0 };
			layers.screen.addChild(resource.graphics);
			flashResources.set(clip.id, resource);
		}
		if (resource.width !== screen.width || resource.height !== screen.height) {
			resource.graphics
				.clear()
				.rect(0, 0, screen.width, screen.height)
				.fill(0xffffff);
			resource.width = screen.width;
			resource.height = screen.height;
		}
		resource.graphics.tint = finite(clip.params.color)
			? clip.params.color
			: options.getAccentColor();
		resource.graphics.alpha =
			Math.sin(progress * Math.PI) *
			(finite(clip.params.alpha) ? clip.params.alpha : 0.45);
		resource.graphics.visible = progress > 0 && progress < 1;
	}

	function createParticles(
		clip: BoardProceduralClip,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	): ParticleResource {
		const requested = finite(clip.params.count)
			? Math.max(1, Math.floor(clip.params.count))
			: 120;
		const count = Math.min(requested, particleLimit());
		const indexes = Array.from({ length: count }, (_, index) =>
			Math.floor((index * requested) / count),
		);
		const particles = indexes.map(
			() =>
				new Particle({
					texture: Texture.WHITE,
					anchorX: 0.5,
					anchorY: 0.5,
					alpha: 0,
				}),
		);
		const container = new ParticleContainer({
			texture: Texture.WHITE,
			particles,
			boundsArea: boundsParam(clip.params.bounds),
			dynamicProperties: {
				position: true,
				rotation: true,
				vertex: true,
				color: true,
			},
		});
		container.blendMode = "add";
		layerForClip(clip, layers).addChild(container);
		return { container, particles, indexes };
	}

	function updateParticles(
		clip: BoardProceduralClip,
		localTime: number,
		playback: BoardPlaybackSnapshot,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	) {
		let resource = particleResources.get(clip.id);
		if (!resource) {
			resource = createParticles(clip, layers);
			particleResources.set(clip.id, resource);
		}
		const bounds = boundsParam(clip.params.bounds);
		const center = record(clip.params.center);
		const centerX = finite(center?.x) ? center.x : bounds.x + bounds.width / 2;
		const centerY = finite(center?.y) ? center.y : bounds.y + bounds.height / 2;
		const speed = finite(clip.params.speed)
			? clip.params.speed
			: Math.min(bounds.width, bounds.height) * 0.42;
		const gravity = finite(clip.params.gravity) ? clip.params.gravity : 180;
		const color = finite(clip.params.color)
			? clip.params.color
			: options.getAccentColor();
		for (let index = 0; index < resource.particles.length; index += 1) {
			const particleIndex = resource.indexes[index];
			const key = `${playback.seed}:${clip.seed}:${particleIndex}`;
			const birth = hashUnit(`${key}:birth`) * clip.duration * 0.18;
			const life = clip.duration * (0.55 + hashUnit(`${key}:life`) * 0.45);
			const age = (localTime - birth) / Math.max(1, life);
			const particle = resource.particles[index];
			if (age < 0 || age > 1) {
				particle.alpha = 0;
				continue;
			}
			const angle = hashUnit(`${key}:angle`) * Math.PI * 2;
			const velocity = speed * (0.45 + hashUnit(`${key}:speed`) * 0.85);
			const seconds = (age * life) / 1_000;
			particle.x = centerX + Math.cos(angle) * velocity * seconds;
			particle.y =
				centerY +
				Math.sin(angle) * velocity * seconds +
				gravity * seconds * seconds * 0.5;
			const scale = 2 + hashUnit(`${key}:size`) * 5;
			particle.scaleX = scale * (1 - age * 0.45);
			particle.scaleY = Math.max(1, scale * 0.35);
			particle.rotation = angle + age * 4;
			particle.tint = color;
			particle.alpha = (1 - age) ** 2;
		}
		resource.container.visible = true;
	}

	function nodeTimelinePose(
		nodeId: string,
		sequence: BoardComposition,
		position: number,
		loop: boolean,
	): AnimationPose {
		const pose = createPose();
		const samplePosition = timelinePosition(
			position,
			sequence.timeline.duration,
			loop,
		);
		const clips =
			motionClipsByComposition.get(compositionKey(sequence))?.get(nodeId) ?? [];
		for (const clip of clips) {
			const sample = clipSampleAt(clip, samplePosition);
			if (!sample) continue;
			composePose(pose, samplePathPose(clip, sample.localTime));
		}
		return pose;
	}

	function updateTrail(
		clip: BoardProceduralClip,
		sequence: BoardComposition,
		position: number,
		progress: number,
		loop: boolean,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	) {
		if (clip.target.type !== "item") return;
		const entry = nodeWithBase(clip.target.itemId);
		if (!entry) return;
		let resource = trailResources.get(clip.id);
		if (!resource) {
			const points = Array.from(
				{ length: 16 },
				() => new Point(entry.base.x, entry.base.y),
			);
			const rope = new MeshRope({
				texture: Texture.WHITE,
				points,
				width: finite(clip.params.width) ? clip.params.width : 16,
			});
			rope.blendMode = "add";
			layerForClip(clip, layers).addChild(rope);
			resource = { rope, points };
			trailResources.set(clip.id, resource);
		}
		const history = finite(clip.params.history)
			? Math.max(16, clip.params.history)
			: 360;
		for (let index = 0; index < resource.points.length; index += 1) {
			const samplePosition =
				position - history * (1 - index / (resource.points.length - 1));
			const pose = nodeTimelinePose(
				clip.target.itemId,
				sequence,
				samplePosition,
				loop,
			);
			resource.points[index].set(entry.base.x + pose.x, entry.base.y + pose.y);
		}
		resource.rope.tint = finite(clip.params.color)
			? clip.params.color
			: options.getAccentColor();
		resource.rope.alpha =
			Math.sin(progress * Math.PI) *
			(finite(clip.params.alpha) ? clip.params.alpha : 0.48);
		resource.rope.visible = progress > 0 && progress < 1;
	}

	function updateDrawReveal(
		clip: BoardProceduralClip,
		progress: number,
	): boolean {
		if (clip.target.type !== "item") return false;
		const entry = options.getNode(clip.target.itemId);
		if (entry?.item.type !== "draw") return false;
		let resource = revealResources.get(clip.id);
		if (!resource) {
			const geometry = drawRevealGeometry(entry.item);
			const original = entry.container.children[0];
			if (!geometry || !(original instanceof Container)) return false;
			const shader = createRevealShader();
			const mesh = new Mesh({ geometry, shader, texture: Texture.WHITE });
			mesh.tint = options.getAccentColor();
			entry.container.addChild(mesh);
			const created: RevealResource = {
				mesh,
				shader,
				geometry,
				original,
				originalRenderable: original.renderable,
			};
			revealResources.set(clip.id, created);
			resource = created;
		}
		resource.original.renderable = false;
		resource.mesh.visible = true;
		resource.mesh.tint = finite(clip.params.color)
			? clip.params.color
			: options.getAccentColor();
		resource.shader.resources.revealUniforms.uniforms.uProgress = progress;
		return true;
	}

	function applyClip(
		clip: BoardProceduralClip,
		sequence: BoardComposition,
		position: number,
		playback: BoardPlaybackSnapshot,
		loop: boolean,
		poses: Map<string, AnimationPose>,
		cameraPose: AnimationPose,
		jobs: Array<() => void>,
		layers: NonNullable<ReturnType<RuntimeOptions["getLayers"]>>,
	): boolean {
		const sample = clipSampleAt(clip, position);
		if (!sample) return false;
		const { localTime, progress } = sample;
		if (clip.kind === "motion.path" && clip.target.type === "item") {
			composePose(
				poseFor(poses, clip.target.itemId),
				samplePathPose(clip, localTime),
			);
			return true;
		}
		if (
			(clip.kind === "draw.reveal" || clip.kind === "text.reveal") &&
			clip.target.type === "item"
		) {
			if (clip.kind !== "text.reveal" && updateDrawReveal(clip, progress))
				return true;
			composePose(poseFor(poses, clip.target.itemId), {
				alpha: progress,
				scale: 0.96 + progress * 0.04,
			});
			return true;
		}
		if (clip.kind === "effects.particles") {
			jobs.push(() => updateParticles(clip, localTime, playback, layers));
			return true;
		}
		if (clip.kind === "effects.trail") {
			jobs.push(() =>
				updateTrail(clip, sequence, position, progress, loop, layers),
			);
			return true;
		}
		if (clip.kind === "effects.impact") {
			jobs.push(() => updateImpact(clip, progress, layers));
			return true;
		}
		if (clip.kind === "effects.flash") {
			jobs.push(() => updateFlash(clip, progress, layers));
			return true;
		}
		if (clip.kind === "camera.shake") {
			const amount = finite(clip.params.amount) ? clip.params.amount : 8;
			const frequency = finite(clip.params.frequency)
				? clip.params.frequency
				: 28;
			const phase = hashUnit(`${playback.seed}:${clip.seed}`) * Math.PI * 2;
			const decay = 1 - progress;
			composePose(cameraPose, {
				x: Math.sin((localTime / 1_000) * frequency + phase) * amount * decay,
				y:
					Math.cos((localTime / 1_000) * frequency * 1.17 + phase) *
					amount *
					decay,
			});
			return true;
		}
		return false;
	}

	function cameraFocusPose(
		compositionId: string,
		position: number,
		base: BasePose,
	): AnimationPose | null {
		return resolveCameraFocusPose({
			clips: cameraFocusBySequence.get(compositionId) ?? [],
			position,
			base: { x: base.x, y: base.y, zoom: base.scaleX },
			resolveTarget(entry) {
				const screen = options.getScreen();
				const geometryVersion = options.getGeometryVersion?.();
				const key = `${compositionId}:${entry.clip.id}`;
				const cached =
					geometryVersion === undefined
						? null
						: cameraFocusTargetCache.get(key);
				if (
					cached &&
					cached.geometryVersion === geometryVersion &&
					cached.width === screen.width &&
					cached.height === screen.height
				) {
					return cached.target;
				}
				const target = cameraForFocus(
					entry.params,
					(id) =>
						options.getItem?.(id)?.frame ?? options.getNode(id)?.item.frame,
					screen,
				);
				if (geometryVersion !== undefined) {
					cameraFocusTargetCache.set(key, {
						geometryVersion,
						width: screen.width,
						height: screen.height,
						target,
					});
				}
				return target;
			},
		});
	}

	function renderFrame(now: number, commitRender = true): boolean {
		restoreAll();
		const layers = options.getLayers();
		const world = options.getWorld();
		if (!layers || !world) return false;
		worldPose ??= poseOf(world);
		const poses = new Map<string, AnimationPose>();
		const cameraPose = createPose();
		let hasContinuousEffect = false;
		if (!reducedMotion) {
			for (const effect of activeEffects) {
				hasContinuousEffect =
					applyEffect(effect, now, poses) || hasContinuousEffect;
			}
		}

		const playback = sharedPlayback ?? autoplayPlayback;
		const sequence = playbackComposition(playback);
		const loop = sequence?.playback.loop ?? false;
		const sample =
			playback && sequence
				? playbackSampleAt(playback, sequence.timeline.duration, now, loop)
				: null;
		const position = sample?.position ?? 0;
		const ended = sample?.ended ?? false;
		let evaluationTime: number | null = null;
		if (sequence) {
			if (reducedMotion) {
				const fallback = sequence.playback.reducedMotion;
				evaluationTime =
					fallback.mode === "time"
						? fallback.time
						: fallback.mode === "marker"
							? (sequence.timeline.markers.find(
									(marker) => marker.id === fallback.markerId,
								)?.time ?? null)
							: null;
			} else if (sample?.waiting) evaluationTime = 0;
			else if (playback?.status === "stopped" || ended) {
				evaluationTime =
					sequence.playback.endBehavior === "hold"
						? sequence.timeline.duration
						: null;
			} else evaluationTime = position;
		}
		if (sequence && evaluationTime !== null) {
			for (const [itemId, pose] of compositionItemPoses(
				sequence,
				evaluationTime,
			)) {
				composePose(poseFor(poses, itemId), pose);
			}
		}
		let hasSupportedClip = false;
		const jobs: Array<() => void> = [];
		if (
			playback &&
			playback.status !== "stopped" &&
			sequence &&
			!reducedMotion &&
			!ended &&
			!sample?.waiting
		) {
			for (const clip of sequence.timeline.clips) {
				if (clip.kind === "camera.focus") continue;
				hasSupportedClip =
					applyClip(
						clip,
						sequence,
						position,
						playback,
						loop,
						poses,
						cameraPose,
						jobs,
						layers,
					) || hasSupportedClip;
			}
		}

		if (playback && sequence && evaluationTime !== null && !reducedMotion) {
			const focus = cameraFocusPose(sequence.id, evaluationTime, worldPose);
			if (focus) {
				composePose(cameraPose, focus);
				hasSupportedClip = true;
			}
		}

		for (const [nodeId, pose] of poses) {
			const entry = nodeWithBase(nodeId);
			if (entry) applyPose(entry.container, entry.base, pose);
		}
		applyPose(world, worldPose, cameraPose);
		for (const job of jobs) job();
		if (commitRender) options.render();

		const playbackActive =
			!reducedMotion &&
			playback?.status === "playing" &&
			Boolean(sequence) &&
			!ended &&
			!sample?.waiting;
		return (
			hasContinuousEffect ||
			Boolean(
				playbackActive &&
					(hasSupportedClip || (sequence?.timeline.tracks.length ?? 0) > 0),
			)
		);
	}

	function tick() {
		frameId = 0;
		if (destroyed || !active || document.hidden) return;
		if (renderFrame(Date.now())) frameId = requestAnimationFrame(tick);
	}

	function start() {
		if (!frameId && !destroyed && active && !document.hidden)
			frameId = requestAnimationFrame(tick);
	}

	function clearAutoplayTimer() {
		if (autoplayTimer) clearTimeout(autoplayTimer);
		autoplayTimer = null;
	}

	function scheduleAutoplayStart() {
		clearAutoplayTimer();
		if (!autoplayPlayback || destroyed || !active) return;
		const remaining = autoplayPlayback.effectiveAt - Date.now();
		if (remaining <= 0) {
			start();
			return;
		}
		autoplayTimer = setTimeout(
			scheduleAutoplayStart,
			Math.min(remaining, 2_147_483_647),
		);
	}

	function syncPlayback() {
		if (data.playback) {
			clearAutoplayTimer();
			autoplayKey = null;
			autoplayPlayback = null;
			// Server and client clocks may differ. Anchor each shared revision once.
			const effectiveAt =
				sharedPlayback?.playbackId === data.playback.playbackId &&
				sharedPlayback.playbackRevision === data.playback.playbackRevision
					? sharedPlayback.effectiveAt
					: data.playback.status === "playing"
						? Math.min(data.playback.effectiveAt, Date.now())
						: data.playback.effectiveAt;
			sharedPlayback =
				effectiveAt === data.playback.effectiveAt
					? data.playback
					: { ...data.playback, effectiveAt };
			return;
		}
		sharedPlayback = null;
		if (!active) return;
		const policy = data.playbackPolicy;
		const sequence = policy
			? (compositionById.get(policy.compositionId) ?? null)
			: null;
		if (
			!policy ||
			!sequence ||
			(sequence.playback.loop && sequence.timeline.duration <= 0)
		) {
			clearAutoplayTimer();
			autoplayKey = null;
			autoplayPlayback = null;
			return;
		}
		const key = `${sequence.id}:${sequence.revision}:${policy.delayMs}:${sequence.playback.loop}`;
		if (key === autoplayKey && autoplayPlayback) return;
		autoplayKey = key;
		autoplayPlayback = {
			boardId: data.boardId,
			playbackId: crypto.randomUUID(),
			compositionId: sequence.id,
			compositionRevision: sequence.revision,
			playbackRevision: 0,
			status: "playing",
			position: 0,
			effectiveAt: Date.now() + policy.delayMs,
			timeScale: 1,
			seed: sequence.id,
		};
		scheduleAutoplayStart();
	}

	function setData(next: BoardRuntimeData) {
		if (next.compositions !== data.compositions) {
			clearResources();
			cameraFocusBySequence = prepareCameraFocusClips(next.compositions);
			cameraFocusTargetCache.clear();
		}
		if (
			next.compositions !== data.compositions ||
			next.effects !== data.effects
		) {
			rebuildRuntimeIndexes(next);
		}
		data = next;
		materializationVersion += 1;
		syncPlayback();
		start();
	}

	function setActive(next: boolean) {
		if (active === next || destroyed) return;
		active = next;
		if (!active) {
			clearAutoplayTimer();
			cancelAnimationFrame(frameId);
			frameId = 0;
			return;
		}
		syncPlayback();
		if (autoplayPlayback && !autoplayTimer) scheduleAutoplayStart();
		start();
	}

	function prepareSceneSync() {
		// Animated transforms are transient. Scene renderers must receive containers
		// at their persisted poses or the next frame will compound pulse/float values.
		restoreSceneState();
	}

	/**
	 * Nodes that need live containers for the next animation frame. The scene's
	 * far LOD can batch everything else, but transforms, filters and effect
	 * resources need an actual display object to update.
	 */
	function nodeIdsToMaterialize(now = Date.now()): Set<string> {
		const playback = sharedPlayback ?? autoplayPlayback;
		const sequence = playbackComposition(playback);
		const loop = sequence?.playback.loop ?? false;
		const ended = Boolean(
			sequence &&
				playback &&
				(reducedMotion ||
					playback.status === "stopped" ||
					playbackSampleAt(playback, sequence.timeline.duration, now, loop)
						.ended),
		);
		const mode = sequence ? (ended ? "rest" : "active") : "effects";
		if (
			materializationCacheVersion === materializationVersion &&
			materializationCacheMode === mode
		)
			return materializationCache;

		const ids = new Set<string>();
		for (const effect of activeEffects) {
			if (
				effect.enabled &&
				effect.lifecycle !== "manual" &&
				effect.target.type === "item"
			)
				ids.add(effect.target.itemId);
		}

		if (sequence) {
			const poses = ended
				? compositionItemPoses(sequence, sequence.timeline.duration).keys()
				: compositionItemPoses(sequence, 0).keys();
			for (const itemId of poses) ids.add(itemId);
			for (const itemId of targetIdsByComposition.get(
				compositionKey(sequence),
			) ?? [])
				ids.add(itemId);
		}

		materializationCache = ids;
		materializationCacheVersion = materializationVersion;
		materializationCacheMode = mode;
		return ids;
	}

	function applyCurrentState(now = Date.now()) {
		if (!destroyed && active && !document.hidden) renderFrame(now, false);
	}

	function invalidatePoses() {
		basePoses.clear();
		worldPose = null;
		// Scene sync may materialize the first target after the runtime's initial
		// frame has stopped. Resume only when there is animation data to evaluate.
		if (data.effects.length > 0 || data.playback || autoplayPlayback) start();
	}

	function visibilityChanged() {
		if (document.hidden) {
			cancelAnimationFrame(frameId);
			frameId = 0;
		} else start();
	}

	function motionPreferenceChanged() {
		reducedMotion = motionQuery.matches;
		start();
	}

	reducedMotion = motionQuery.matches;
	document.addEventListener("visibilitychange", visibilityChanged);
	motionQuery.addEventListener("change", motionPreferenceChanged);

	return {
		setData,
		setActive,
		start,
		nodeIdsToMaterialize,
		prepareSceneSync,
		applyCurrentState,
		invalidatePoses,
		destroy() {
			destroyed = true;
			clearAutoplayTimer();
			cancelAnimationFrame(frameId);
			frameId = 0;
			document.removeEventListener("visibilitychange", visibilityChanged);
			motionQuery.removeEventListener("change", motionPreferenceChanged);
			clearResources();
			restoreAll();
			basePoses.clear();
			effectOrigins.clear();
			effectVisibility.clear();
		},
	};
}
