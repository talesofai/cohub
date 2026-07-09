import type { SpaceFsEntry, SpaceFsFileResponse } from "@neta-art/cohub";
import { isTextFileResponse } from "$lib/space-file-text";
import type { SpaceFsNode } from "$lib/space-fs";

export const isMarkdownPath = (path: string) => /\.md$/i.test(path);

export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

export const hasRenderedFilePreview = (file: SpaceFsFileResponse) =>
	isTextFileResponse(file) &&
	(isMarkdownPath(file.path) || isHtmlPath(file.path));

export function makeFsNode(entry: SpaceFsEntry): SpaceFsNode {
	return {
		...entry,
		children: [],
		isOpen: false,
		isLoaded: false,
		isLoading: false,
	};
}

export function buildFsEntry(
	path: string,
	type: SpaceFsEntry["type"],
): SpaceFsEntry {
	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	const name = normalizedPath.split("/").pop() ?? normalizedPath;
	return {
		name,
		path: normalizedPath,
		type,
		size: 0,
		mimeType: null,
		mtimeMs: Date.now(),
	};
}

export function getParentDirPath(path: string): string {
	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	if (!normalizedPath.includes("/")) return "";
	return normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
}

export function mergeFsNodeLists(
	nodes: SpaceFsNode[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	if (previousNodes.length === 0) return nodes;
	const previousByPath = new Map(
		previousNodes.map((node) => [node.path, node]),
	);
	return nodes.map((node) => {
		const previous = previousByPath.get(node.path);
		if (!previous || previous.type !== node.type) return node;
		if (node.type !== "dir") return node;
		return {
			...node,
			children: previous.children,
			isOpen: previous.isOpen,
			isLoaded: previous.isLoaded,
			isLoading: false,
		};
	});
}

export function makeFsNodes(
	entries: SpaceFsEntry[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	return mergeFsNodeLists(entries.map(makeFsNode), previousNodes);
}

export function replaceNodeChildren(
	nodes: SpaceFsNode[],
	nodePath: string,
	children: SpaceFsNode[],
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath)
			return {
				...node,
				children: mergeFsNodeLists(children, node.children),
				isLoaded: true,
				isLoading: false,
				isOpen: true,
			};
		if (node.children.length > 0)
			return {
				...node,
				children: replaceNodeChildren(node.children, nodePath, children),
			};
		return node;
	});
}

export function updateNodeState(
	nodes: SpaceFsNode[],
	nodePath: string,
	updater: (node: SpaceFsNode) => SpaceFsNode,
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath) return updater(node);
		if (node.children.length > 0)
			return {
				...node,
				children: updateNodeState(node.children, nodePath, updater),
			};
		return node;
	});
}
