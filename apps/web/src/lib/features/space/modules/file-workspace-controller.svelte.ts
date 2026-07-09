import type { SpaceFsEntry, SpaceFsFileResponse } from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { goto } from "$app/navigation";
import {
	canvasItemToNode,
	createEmptyCovasDocument,
} from "$lib/canvas/canvas-document";
import { ensureCovasExtension, isCovasFile } from "$lib/canvas/canvas-file";
import { sdk } from "$lib/sdk";
import {
	buildSpaceFileDownloadUrl,
	downloadSpaceFile,
} from "$lib/space-file-download";
import {
	isTextFileResponse,
	resolveTextFileResponse,
} from "$lib/space-file-text";
import type { SpaceFsNode } from "$lib/space-fs";
import { buildSpaceFileRoute } from "$lib/space-routes";
import {
	clearCachedSpaceFsSubtree,
	fetchSpaceFsDirWithCache,
	getCachedSpaceFsDir,
	patchCachedSpaceFsDir,
} from "$lib/stores/space-fs-cache";
import type { WorkspaceFilePosition } from "$lib/workspace-file-links";
import { type ActiveFsSource, createActiveFsClient } from "./active-fs-client";
import {
	buildFsEntry,
	getParentDirPath,
	hasRenderedFilePreview,
	isHtmlPath,
	isMarkdownPath,
	makeFsNodes,
	replaceNodeChildren,
	updateNodeState,
} from "./file-workspace-utils";

export type { ActiveFsSource };

export type FileWorkspaceInlineFile = {
	response: SpaceFsFileResponse | null;
	draft: string;
	path: string;
	position: WorkspaceFilePosition | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
	tooLarge: boolean;
	edit: boolean;
	zoom: number;
	panX: number;
	panY: number;
	dragging: boolean;
	copied: boolean;
	backStack: string[];
	requestToken: number;
};

type FileWorkspaceControllerOptions = {
	getSpaceId: () => string;
	getActiveFsSource: () => ActiveFsSource;
	getActiveFsSourceKey: () => string;
	getRouteFilePath: () => string | null;
	getCanEditFiles: () => boolean;
	getActiveFsReadonly: () => boolean;
	getSpaceHasMinimalAccess: () => boolean;
	onCloseRouteFile: () => void;
	onOpenInlineCanvas: (path: string) => Promise<void>;
	onCloseInlineCanvas: () => void;
	onRenameInlineCanvas?: (fromPath: string, toPath: string) => void;
	onOpenInlinePort: (
		port: string,
		url: string,
		options?: { autoOpened?: boolean },
	) => void;
	onCloseInlinePort: () => void;
	onActivateFilePreview?: () => void;
	onClosePreviewFocusMode: () => void;
	onEnsurePreviewPanelFits: () => void;
};

export function createFileWorkspaceController(
	options: FileWorkspaceControllerOptions,
) {
	let fileTree = $state<SpaceFsNode[]>([]);
	let fileTreeBySource = $state<Record<string, SpaceFsNode[]>>({});
	let fileTreeSourceKey = $state("live");
	let fileTreeLoading = $state(false);
	let fileTreeError = $state<string | null>(null);
	let fileTreeRequestToken = $state(0);
	let directoryLoadTokenByPath = $state<Record<string, number>>({});
	let openFile = $state<SpaceFsFileResponse | null>(null);
	let openFileDraft = $state("");
	let openFileLoading = $state(false);
	let openFileSaving = $state(false);
	let openFileError = $state<string | null>(null);
	let openFileTooLarge = $state(false);
	let inlineFileTabs = $state<FileWorkspaceInlineFile[]>([]);
	let activeInlineFilePath = $state<string | null>(null);
	let inlineFileRequestToken = $state(0);
	let fileEdit = $state(true);
	let fileActionMenuOpenPath = $state<string | null>(null);
	let openFileZoom = $state(1);
	let openFilePanX = $state(0);
	let openFilePanY = $state(0);
	let openFileDragging = $state(false);
	let inlineFileCopiedTimer: ReturnType<typeof setTimeout> | null = null;
	let openFileCopied = $state(false);
	let openFileCopiedTimer: ReturnType<typeof setTimeout> | null = null;
	let uploadPaneVisible = $state(false);
	let uploadPaneTargetDir = $state("");
	let pendingUploadFiles = $state<File[]>([]);
	let pendingUploadEntries = $state<{ file: File; relativePath: string }[]>([]);
	let pendingFileSavePaths = $state<Set<string>>(new Set());

	const getActiveInlineFile = () =>
		inlineFileTabs.find((tab) => tab.path === activeInlineFilePath) ?? null;

	function setInlineFileTab(
		path: string,
		updater: (tab: FileWorkspaceInlineFile) => FileWorkspaceInlineFile,
	) {
		inlineFileTabs = inlineFileTabs.map((tab) =>
			tab.path === path ? updater(tab) : tab,
		);
	}

	function makeInlineFileTab(
		path: string,
		position: WorkspaceFilePosition | null,
		requestToken: number,
		backStack: string[] = [],
	): FileWorkspaceInlineFile {
		return {
			response: null,
			draft: "",
			path,
			position,
			loading: true,
			saving: false,
			error: null,
			tooLarge: false,
			edit: true,
			zoom: 1,
			panX: 0,
			panY: 0,
			dragging: false,
			copied: false,
			backStack,
			requestToken,
		};
	}

	function isLocalUploadEntries(
		value: File[] | { file: File; relativePath: string }[],
	): value is { file: File; relativePath: string }[] {
		return value.length > 0 && "file" in value[0] && "relativePath" in value[0];
	}

	function isOwnPendingFileSave(
		path: string | undefined,
		source?: string,
		kind?: string,
	) {
		return Boolean(
			path &&
				source === "api-fs" &&
				kind === "modify" &&
				pendingFileSavePaths.has(path),
		);
	}

	function markFileSavePending(path: string) {
		pendingFileSavePaths = new Set(pendingFileSavePaths).add(path);
	}

	function clearFileSavePendingSoon(path: string) {
		setTimeout(() => {
			const next = new Set(pendingFileSavePaths);
			next.delete(path);
			pendingFileSavePaths = next;
		}, 3000);
	}

	function setActiveFileTree(nodes: SpaceFsNode[]) {
		fileTree = nodes;
		fileTreeBySource = {
			...fileTreeBySource,
			[options.getActiveFsSourceKey()]: nodes,
		};
	}

	function updateRootFsEntries(entries: SpaceFsEntry[]) {
		setActiveFileTree(makeFsNodes(entries, fileTree));
	}

	function switchSource(sourceKey: string) {
		if (fileTreeSourceKey === sourceKey) return;
		fileTreeBySource = { ...fileTreeBySource, [fileTreeSourceKey]: fileTree };
		fileTreeSourceKey = sourceKey;
		fileTree = fileTreeBySource[sourceKey] ?? [];
		directoryLoadTokenByPath = {};
		fileTreeError = null;
		fileTreeLoading = false;
		fileTreeRequestToken += 1;
		inlineFileRequestToken += 1;
		inlineFileTabs = [];
		activeInlineFilePath = null;
		void loadFileTree(false);
	}

	function clearRouteFile() {
		openFile = null;
		openFileDraft = "";
		openFileError = null;
		openFileTooLarge = false;
		fileEdit = true;
	}

	function resetForSpace() {
		fileTree = [];
		fileTreeBySource = {};
		fileTreeSourceKey = "live";
		fileTreeLoading = false;
		fileTreeError = null;
		directoryLoadTokenByPath = {};
		fileTreeRequestToken += 1;
		inlineFileRequestToken += 1;
		openFile = null;
		openFileDraft = "";
		openFileError = null;
		openFileTooLarge = false;
		openFileSaving = false;
		inlineFileTabs = [];
		activeInlineFilePath = null;
		uploadPaneVisible = false;
		pendingUploadFiles = [];
		pendingUploadEntries = [];
		pendingFileSavePaths = new Set();
	}

	function markOpenFileExternalChange() {
		openFileError =
			"File changed externally. Save carefully or reload before editing further.";
	}

	function markInlineFileExternalChange(path?: string) {
		const targetPath = path ?? activeInlineFilePath;
		if (!targetPath) return;
		setInlineFileTab(targetPath, (tab) => ({
			...tab,
			error:
				"File changed externally. Save carefully or reload before editing further.",
		}));
	}

	async function patchFsDirectory(
		dirPath: string,
		updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
	) {
		const nextEntries = await patchCachedSpaceFsDir(
			options.getSpaceId(),
			dirPath,
			updater,
		);
		if (dirPath === "") {
			updateRootFsEntries(nextEntries);
			return nextEntries;
		}
		setActiveFileTree(
			replaceNodeChildren(fileTree, dirPath, makeFsNodes(nextEntries)),
		);
		return nextEntries;
	}

	function getActiveFsClient() {
		return createActiveFsClient({
			spaceId: options.getSpaceId(),
			source: options.getActiveFsSource(),
		});
	}

	function listActiveFsDir(path: string) {
		return getActiveFsClient().list(path);
	}

	function readActiveFsFile(path: string) {
		return getActiveFsClient().read(path);
	}

	async function loadFileTree(force = false) {
		const source = options.getActiveFsSource();
		const sourceKey = options.getActiveFsSourceKey();
		const spaceId = options.getSpaceId();
		if (fileTreeLoading && !force) return;
		const requestToken = fileTreeRequestToken + 1;
		fileTreeRequestToken = requestToken;
		if (options.getSpaceHasMinimalAccess()) {
			setActiveFileTree([]);
			fileTreeLoading = false;
			fileTreeError = "Files are not available for this shared session.";
			return;
		}
		if (!force) {
			if (source.kind === "live") {
				const cached = await getCachedSpaceFsDir(spaceId, "");
				if (
					requestToken !== fileTreeRequestToken ||
					sourceKey !== options.getActiveFsSourceKey()
				)
					return;
				if (cached && cached.length > 0)
					setActiveFileTree(makeFsNodes(cached, fileTree));
			} else {
				const cached = fileTreeBySource[sourceKey];
				if (cached) setActiveFileTree(cached);
			}
		}
		const shouldShowLoading = fileTree.length === 0 || force;
		if (shouldShowLoading) fileTreeLoading = true;
		fileTreeError = null;
		try {
			const client = createActiveFsClient({ spaceId, source });
			const entries =
				source.kind === "live"
					? await fetchSpaceFsDirWithCache(
							spaceId,
							"",
							async () => (await client.list("")).entries,
							{ force: true },
						)
					: (await client.list("")).entries;
			if (
				requestToken !== fileTreeRequestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			setActiveFileTree(makeFsNodes(entries, fileTree));
		} catch (error) {
			if (
				requestToken !== fileTreeRequestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			fileTreeError =
				error instanceof Error ? error.message : "Failed to load files";
		} finally {
			if (
				requestToken === fileTreeRequestToken &&
				sourceKey === options.getActiveFsSourceKey()
			)
				fileTreeLoading = false;
		}
	}

	async function expandDirectory(node: SpaceFsNode) {
		if (node.type !== "dir") return;
		if (node.isOpen) {
			directoryLoadTokenByPath = {
				...directoryLoadTokenByPath,
				[node.path]: (directoryLoadTokenByPath[node.path] ?? 0) + 1,
			};
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isOpen: false,
					isLoading: false,
				})),
			);
			return;
		}
		const requestToken = (directoryLoadTokenByPath[node.path] ?? 0) + 1;
		directoryLoadTokenByPath = {
			...directoryLoadTokenByPath,
			[node.path]: requestToken,
		};
		const source = options.getActiveFsSource();
		const sourceKey = options.getActiveFsSourceKey();
		const hasExistingChildren = node.children.length > 0;
		const cached =
			source.kind === "live"
				? await getCachedSpaceFsDir(options.getSpaceId(), node.path)
				: null;
		if (directoryLoadTokenByPath[node.path] !== requestToken) return;
		if (cached) {
			setActiveFileTree(
				replaceNodeChildren(fileTree, node.path, makeFsNodes(cached)),
			);
		} else {
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isLoading: !hasExistingChildren,
					isOpen: true,
				})),
			);
		}
		try {
			const requestSpaceId = options.getSpaceId();
			const client = createActiveFsClient({
				spaceId: requestSpaceId,
				source,
			});
			const entries =
				source.kind === "live"
					? await fetchSpaceFsDirWithCache(
							requestSpaceId,
							node.path,
							async () => (await client.list(node.path)).entries,
							{ force: true },
						)
					: (await client.list(node.path)).entries;
			if (
				directoryLoadTokenByPath[node.path] !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			setActiveFileTree(
				replaceNodeChildren(fileTree, node.path, makeFsNodes(entries)),
			);
		} catch (error) {
			if (directoryLoadTokenByPath[node.path] !== requestToken) return;
			setActiveFileTree(
				updateNodeState(fileTree, node.path, (item) => ({
					...item,
					isLoading: false,
				})),
			);
			fileTreeError =
				error instanceof Error ? error.message : "Failed to load directory";
		}
	}

	function refreshFileTree() {
		return loadFileTree(true);
	}

	function openSpaceFile(path: string) {
		void goto(buildSpaceFileRoute(options.getSpaceId(), path), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function closeFile() {
		options.onCloseRouteFile();
	}

	async function openFileFromUrl(path: string) {
		const requestSpaceId = options.getSpaceId();
		const isCurrentRequest = () =>
			options.getSpaceId() === requestSpaceId &&
			options.getRouteFilePath() === path;
		options.onCloseInlinePort();
		openFileLoading = true;
		openFileError = null;
		openFileTooLarge = false;
		try {
			const rawFile = await readActiveFsFile(path);
			if (!isCurrentRequest()) return;
			if (!("content" in rawFile)) {
				openFile = null;
				openFileDraft = "";
				openFileError = "File is being prepared. Please retry shortly.";
				return;
			}
			const file = await resolveTextFileResponse(rawFile);
			if (!isCurrentRequest()) return;
			fileEdit = !hasRenderedFilePreview(file);
			openFile = file;
			openFileDraft = isTextFileResponse(file) ? file.content : "";
		} catch (error) {
			if (!isCurrentRequest()) return;
			if (error instanceof HttpError && error.status === 413) {
				openFileTooLarge = true;
				openFile = null;
				openFileDraft = "";
				openFileError = null;
			} else {
				openFileError =
					error instanceof Error ? error.message : "Failed to open file";
			}
		} finally {
			if (isCurrentRequest()) openFileLoading = false;
		}
	}

	async function saveOpenFile() {
		const current = openFile;
		if (!current || !options.getCanEditFiles() || !isTextFileResponse(current))
			return;
		const savingPath = current.path;
		markFileSavePending(savingPath);
		openFileSaving = true;
		openFileError = null;
		try {
			await sdk.space(options.getSpaceId()).files.write({
				path: savingPath,
				content: openFileDraft,
				encoding: "utf-8",
			});
			const nextFile: SpaceFsFileResponse = {
				...current,
				kind: "text",
				encoding: "utf-8",
				content: openFileDraft,
				size: new Blob([openFileDraft]).size,
			};
			openFile = nextFile;
			await patchFsDirectory(getParentDirPath(savingPath), (entries) =>
				entries.map((entry) =>
					entry.path === savingPath
						? {
								...entry,
								size: new Blob([openFileDraft]).size,
								mtimeMs: Date.now(),
							}
						: entry,
				),
			);
		} catch (error) {
			openFileError =
				error instanceof Error ? error.message : "Failed to save file";
		} finally {
			openFileSaving = false;
			clearFileSavePendingSoon(savingPath);
		}
	}

	async function downloadActiveFsFile(
		path: string,
		knownFile: SpaceFsFileResponse | null | undefined,
	) {
		await getActiveFsClient().download(path, knownFile);
	}

	async function downloadOpenFile() {
		const routeFilePath = options.getRouteFilePath();
		if (!routeFilePath) return;
		await downloadSpaceFile(
			options.getSpaceId(),
			routeFilePath,
			routeFilePath.split("/").pop() ?? "download",
			openFile,
		);
	}

	async function downloadInlineFile() {
		const inlineFile = getActiveInlineFile();
		if (!inlineFile) return;
		try {
			await downloadActiveFsFile(inlineFile.path, inlineFile.response);
		} catch (error) {
			setInlineFileTab(inlineFile.path, (tab) => ({
				...tab,
				error:
					error instanceof Error ? error.message : "Failed to download file",
			}));
		}
	}

	async function openInlineFile(
		path: string,
		optionsArg: {
			preserveHistory?: boolean;
			skipHistoryPush?: boolean;
			position?: WorkspaceFilePosition | null;
			activate?: boolean;
			forceReload?: boolean;
		} = {},
	) {
		const existingTab = inlineFileTabs.find((tab) => tab.path === path);
		const currentTab = getActiveInlineFile();
		const nextBackStack =
			optionsArg.preserveHistory &&
			!optionsArg.skipHistoryPush &&
			currentTab?.path &&
			currentTab.path !== path
				? [...(existingTab?.backStack ?? []), currentTab.path]
				: optionsArg.preserveHistory
					? (existingTab?.backStack ?? [])
					: [];
		const sourceKey = options.getActiveFsSourceKey();
		const requestToken = inlineFileRequestToken + 1;
		inlineFileRequestToken = requestToken;
		const shouldActivate = optionsArg.activate ?? true;
		if (shouldActivate) {
			activeInlineFilePath = path;
			options.onClosePreviewFocusMode();
			options.onEnsurePreviewPanelFits();
			options.onActivateFilePreview?.();
		}
		if (existingTab) {
			setInlineFileTab(path, (tab) => ({
				...tab,
				position: optionsArg.position ?? tab.position,
				loading: !tab.response,
				error: null,
				tooLarge: false,
				requestToken,
				backStack: nextBackStack,
			}));
			if (existingTab.response && !optionsArg.forceReload) return;
		} else {
			inlineFileTabs = [
				...inlineFileTabs,
				makeInlineFileTab(
					path,
					optionsArg.position ?? null,
					requestToken,
					nextBackStack,
				),
			];
		}
		try {
			const rawFile = await readActiveFsFile(path);
			const targetTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!targetTab ||
				targetTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			if (!("content" in rawFile)) {
				setInlineFileTab(path, (tab) => ({
					...tab,
					response: null,
					draft: "",
					loading: false,
					error: "File is being prepared. Please retry shortly.",
					tooLarge: false,
				}));
				return;
			}
			const file = await resolveTextFileResponse(rawFile);
			const hydratedTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!hydratedTab ||
				hydratedTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			setInlineFileTab(path, (tab) => ({
				...tab,
				response: file,
				draft: isTextFileResponse(file) ? file.content : "",
				loading: false,
				error: null,
				tooLarge: false,
				edit: !hasRenderedFilePreview(file),
			}));
		} catch (error) {
			const targetTab = inlineFileTabs.find((tab) => tab.path === path);
			if (
				!targetTab ||
				targetTab.requestToken !== requestToken ||
				sourceKey !== options.getActiveFsSourceKey()
			)
				return;
			if (error instanceof HttpError && error.status === 413) {
				setInlineFileTab(path, (tab) => ({
					...tab,
					response: null,
					draft: "",
					loading: false,
					error: null,
					tooLarge: true,
				}));
			} else {
				setInlineFileTab(path, (tab) => ({
					...tab,
					response: null,
					draft: "",
					loading: false,
					error: error instanceof Error ? error.message : "Failed to open file",
					tooLarge: false,
				}));
			}
		}
	}

	function closeInlineFile(path = activeInlineFilePath, skipConfirm = false) {
		if (!path) return;
		const tab = inlineFileTabs.find((item) => item.path === path);
		if (
			tab?.response &&
			isTextFileResponse(tab.response) &&
			tab.draft !== tab.response.content &&
			!skipConfirm &&
			!confirm(`Close ${path} with unsaved changes?`)
		)
			return;
		inlineFileRequestToken += 1;
		const closingActive = activeInlineFilePath === path;
		const index = inlineFileTabs.findIndex((item) => item.path === path);
		const nextTabs = inlineFileTabs.filter((item) => item.path !== path);
		inlineFileTabs = nextTabs;
		if (closingActive)
			activeInlineFilePath =
				nextTabs[Math.max(0, index - 1)]?.path ?? nextTabs[0]?.path ?? null;
		if (nextTabs.length === 0) options.onClosePreviewFocusMode();
	}

	async function goBackInlineFile() {
		const tab = getActiveInlineFile();
		const previousPath = tab?.backStack.at(-1);
		if (!tab || !previousPath) return;
		setInlineFileTab(tab.path, (item) => ({
			...item,
			backStack: item.backStack.slice(0, -1),
		}));
		await openInlineFile(previousPath, {
			preserveHistory: true,
			skipHistoryPush: true,
			position: null,
		});
	}

	async function saveInlineFile() {
		const inlineFile = getActiveInlineFile();
		if (
			options.getActiveFsReadonly() ||
			!options.getCanEditFiles() ||
			!inlineFile ||
			!isTextFileResponse(inlineFile.response)
		)
			return;
		const savingPath = inlineFile.path;
		const nextContent = inlineFile.draft;
		markFileSavePending(savingPath);
		setInlineFileTab(savingPath, (tab) => ({
			...tab,
			saving: true,
			error: null,
		}));
		try {
			await sdk.space(options.getSpaceId()).files.write({
				path: savingPath,
				content: nextContent,
				encoding: "utf-8",
			});
			setInlineFileTab(savingPath, (tab) => ({
				...tab,
				response: tab.response
					? ({
							...tab.response,
							content: nextContent,
							size: new Blob([nextContent]).size,
						} as SpaceFsFileResponse)
					: tab.response,
				error: null,
			}));
			await patchFsDirectory(getParentDirPath(savingPath), (entries) =>
				entries.map((entry) =>
					entry.path === savingPath
						? {
								...entry,
								size: new Blob([nextContent]).size,
								mtimeMs: Date.now(),
							}
						: entry,
				),
			);
		} catch (error) {
			setInlineFileTab(savingPath, (tab) => ({
				...tab,
				error: error instanceof Error ? error.message : "Failed to save file",
			}));
		} finally {
			setInlineFileTab(savingPath, (tab) => ({ ...tab, saving: false }));
			clearFileSavePendingSoon(savingPath);
		}
	}

	async function copyFileContent() {
		if (!isTextFileResponse(openFile)) return;
		await navigator.clipboard.writeText(openFileDraft);
		openFileCopied = true;
		if (openFileCopiedTimer) clearTimeout(openFileCopiedTimer);
		openFileCopiedTimer = setTimeout(() => {
			openFileCopied = false;
		}, 1500);
	}

	async function copyInlineFileContent() {
		const inlineFile = getActiveInlineFile();
		if (!inlineFile || !isTextFileResponse(inlineFile.response)) return;
		await navigator.clipboard.writeText(inlineFile.draft);
		setInlineFileTab(inlineFile.path, (tab) => ({ ...tab, copied: true }));
		if (inlineFileCopiedTimer) clearTimeout(inlineFileCopiedTimer);
		const copiedPath = inlineFile.path;
		inlineFileCopiedTimer = setTimeout(() => {
			setInlineFileTab(copiedPath, (tab) => ({
				...tab,
				copied: false,
			}));
		}, 1500);
	}

	function handleUploadFiles(
		files: File[] | { file: File; relativePath: string }[],
		targetDir: string,
	) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		uploadPaneTargetDir = targetDir;
		if (isLocalUploadEntries(files)) {
			pendingUploadEntries = files;
			pendingUploadFiles = [];
		} else {
			pendingUploadFiles = files;
			pendingUploadEntries = files.map((file) => ({
				file,
				relativePath: file.name,
			}));
		}
		uploadPaneVisible = true;
	}

	async function handleUploadComplete() {
		await refreshFileTree();
	}

	async function handleCreateFile(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New file name");
		if (!name?.trim()) return;
		const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
		try {
			await sdk
				.space(options.getSpaceId())
				.files.write({ path, content: "", encoding: "utf-8" });
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "file"),
			]);
			if (isCovasFile(path)) await options.onOpenInlineCanvas(path);
			else await openInlineFile(path);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create file";
		}
	}

	async function handleCreateCanvas(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New canvas name", "Untitled.covas");
		if (!name?.trim()) return;
		const fileName = ensureCovasExtension(name);
		const path = parentPath ? `${parentPath}/${fileName}` : fileName;
		try {
			await sdk.space(options.getSpaceId()).canvas.create({
				path,
				title: fileName,
				nodes: createEmptyCovasDocument().items.map(canvasItemToNode),
			});
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "file"),
			]);
			await options.onOpenInlineCanvas(path);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create canvas";
		}
	}

	async function handleCreateDir(parentPath: string) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const name = prompt("New folder name");
		if (!name?.trim()) return;
		const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
		try {
			await sdk.space(options.getSpaceId()).files.createDir(path);
			await patchFsDirectory(parentPath, (entries) => [
				...entries,
				buildFsEntry(path, "dir"),
			]);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to create folder";
		}
	}

	async function handleRenameNode(node: SpaceFsNode) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		const nextName = prompt("Rename", node.name);
		if (!nextName?.trim() || nextName.trim() === node.name) return;
		const parent = getParentDirPath(node.path);
		const toPath = parent ? `${parent}/${nextName.trim()}` : nextName.trim();
		try {
			await sdk
				.space(options.getSpaceId())
				.files.move({ fromPath: node.path, toPath });
			if (parent === getParentDirPath(toPath)) {
				await patchFsDirectory(parent, (entries) =>
					entries.map((entry) =>
						entry.path === node.path
							? {
									...entry,
									name: nextName.trim(),
									path: toPath,
									mtimeMs: Date.now(),
								}
							: entry,
					),
				);
			} else {
				await patchFsDirectory(parent, (entries) =>
					entries.filter((entry) => entry.path !== node.path),
				);
				await patchFsDirectory(getParentDirPath(toPath), (entries) => [
					...entries,
					{
						...buildFsEntry(toPath, node.type),
						size: node.size,
						mimeType: node.mimeType,
						mtimeMs: Date.now(),
					},
				]);
			}
			if (node.type === "dir")
				await clearCachedSpaceFsSubtree(options.getSpaceId(), node.path);
			if (openFile?.path === node.path) closeFile();
			if (inlineFileTabs.some((tab) => tab.path === node.path))
				renamePath(node.path, toPath);
			options.onRenameInlineCanvas?.(node.path, toPath);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to rename";
		}
	}

	async function handleDownloadNode(node: SpaceFsNode) {
		if (node.type !== "file") return;
		try {
			await downloadActiveFsFile(node.path, null);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to download";
		}
	}

	async function handleDeleteNode(node: SpaceFsNode) {
		if (options.getActiveFsReadonly() || !options.getCanEditFiles()) return;
		if (!confirm(`Delete ${node.name}?`)) return;
		try {
			await sdk
				.space(options.getSpaceId())
				.files.delete(node.path, node.type === "dir");
			await patchFsDirectory(getParentDirPath(node.path), (entries) =>
				entries.filter((entry) => entry.path !== node.path),
			);
			if (node.type === "dir")
				await clearCachedSpaceFsSubtree(options.getSpaceId(), node.path);
			if (openFile?.path === node.path) closeFile();
			if (inlineFileTabs.some((tab) => tab.path === node.path))
				closeInlineFile(node.path);
		} catch (error) {
			fileTreeError =
				error instanceof Error ? error.message : "Failed to delete";
		}
	}

	function findFsNode(
		path: string,
		nodes: SpaceFsNode[] = fileTree,
	): SpaceFsNode | null {
		for (const node of nodes) {
			if (node.path === path) return node;
			const child = findFsNode(path, node.children);
			if (child) return child;
		}
		return null;
	}

	function applyDirectoryEntries(dirPath: string, entries: SpaceFsEntry[]) {
		if (dirPath === "") {
			updateRootFsEntries(entries);
			return;
		}
		setActiveFileTree(
			replaceNodeChildren(fileTree, dirPath, makeFsNodes(entries)),
		);
	}

	function markDirectoryUnloaded(dirPath: string) {
		setActiveFileTree(
			updateNodeState(fileTree, dirPath, (item) => ({
				...item,
				isLoaded: false,
			})),
		);
	}

	function getFileActionNode(path: string): SpaceFsNode {
		const existingNode = findFsNode(path);
		if (existingNode) return existingNode;
		const response =
			openFile?.path === path
				? openFile
				: getActiveInlineFile()?.response?.path === path
					? getActiveInlineFile()?.response
					: null;
		return {
			...buildFsEntry(path, "file"),
			size: response?.size ?? 0,
			mimeType: response?.mimeType ?? null,
			children: [],
			isOpen: false,
			isLoaded: false,
			isLoading: false,
		};
	}

	function closeReadyCopies() {
		if (inlineFileCopiedTimer) clearTimeout(inlineFileCopiedTimer);
		if (openFileCopiedTimer) clearTimeout(openFileCopiedTimer);
	}

	function isInlineFileDirty(path: string) {
		const tab = inlineFileTabs.find((item) => item.path === path);
		return Boolean(
			tab?.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content,
		);
	}

	function dispose() {
		closeReadyCopies();
	}

	function renamePath(fromPath: string, toPath: string) {
		if (openFile?.path === fromPath) openFile = { ...openFile, path: toPath };
		inlineFileTabs = inlineFileTabs.map((tab) =>
			tab.path === fromPath
				? {
						...tab,
						path: toPath,
						response: tab.response
							? {
									...tab.response,
									path: toPath,
									name: toPath.split("/").pop() ?? toPath,
								}
							: tab.response,
					}
				: tab,
		);
		if (activeInlineFilePath === fromPath) activeInlineFilePath = toPath;
	}

	return {
		get fileTree() {
			return fileTree;
		},
		get fileTreeLoading() {
			return fileTreeLoading;
		},
		get fileTreeError() {
			return fileTreeError;
		},
		get openFile() {
			return openFile;
		},
		get openFileDraft() {
			return openFileDraft;
		},
		set openFileDraft(value: string) {
			openFileDraft = value;
		},
		get openFileLoading() {
			return openFileLoading;
		},
		get openFileSaving() {
			return openFileSaving;
		},
		get openFileError() {
			return openFileError;
		},
		get openFileTooLarge() {
			return openFileTooLarge;
		},
		get openFileDownloadUrl() {
			return routeDownloadUrl(options.getSpaceId(), options.getRouteFilePath());
		},
		get openFileDownloadName() {
			return routeDownloadName(options.getRouteFilePath());
		},
		get openFileIsText() {
			return isTextFileResponse(openFile);
		},
		get openFileHasRenderedPreview() {
			return Boolean(openFile && hasRenderedFilePreview(openFile));
		},
		get openFileExt() {
			return isTextFileResponse(openFile)
				? (openFile?.name.split(".").pop()?.toLowerCase() ?? "plaintext")
				: "plaintext";
		},
		get openFileIsMarkdown() {
			return Boolean(
				openFile &&
					isTextFileResponse(openFile) &&
					isMarkdownPath(openFile.path),
			);
		},
		get openFileIsHtml() {
			return Boolean(
				openFile && isTextFileResponse(openFile) && isHtmlPath(openFile.path),
			);
		},
		get openFileIsImage() {
			return Boolean(openFile?.mimeType?.startsWith("image/"));
		},
		get openFileIsVideo() {
			return Boolean(openFile?.mimeType?.startsWith("video/"));
		},
		get openFileDataUrl() {
			const file = openFile;
			if (!file || isTextFileResponse(file)) return null;
			return file.delivery === "url"
				? (file.url ?? null)
				: `data:${file.mimeType ?? "application/octet-stream"};base64,${file.content}`;
		},
		get fileDirty() {
			return Boolean(
				openFile &&
					isTextFileResponse(openFile) &&
					openFileDraft !== openFile.content,
			);
		},
		get fileEdit() {
			return fileEdit;
		},
		set fileEdit(value: boolean) {
			fileEdit = value;
		},
		get fileActionMenuOpenPath() {
			return fileActionMenuOpenPath;
		},
		set fileActionMenuOpenPath(value: string | null) {
			fileActionMenuOpenPath = value;
		},
		get openFileZoom() {
			return openFileZoom;
		},
		set openFileZoom(value: number) {
			openFileZoom = value;
		},
		get openFilePanX() {
			return openFilePanX;
		},
		set openFilePanX(value: number) {
			openFilePanX = value;
		},
		get openFilePanY() {
			return openFilePanY;
		},
		set openFilePanY(value: number) {
			openFilePanY = value;
		},
		get openFileDragging() {
			return openFileDragging;
		},
		set openFileDragging(value: boolean) {
			openFileDragging = value;
		},
		get openFileCopied() {
			return openFileCopied;
		},
		get inlineFile() {
			return getActiveInlineFile();
		},
		get inlineFileTabs() {
			return inlineFileTabs;
		},
		get activeInlineFilePath() {
			return activeInlineFilePath;
		},
		get inlineFileCanGoBack() {
			return Boolean(getActiveInlineFile()?.backStack.length);
		},
		get inlineFileDirty() {
			const tab = getActiveInlineFile();
			return Boolean(
				tab?.response &&
					isTextFileResponse(tab.response) &&
					tab.draft !== tab.response.content,
			);
		},
		get inlineFileIsMarkdown() {
			const response = getActiveInlineFile()?.response;
			return Boolean(
				response &&
					isTextFileResponse(response) &&
					isMarkdownPath(response.path),
			);
		},
		get inlineFileIsHtml() {
			const response = getActiveInlineFile()?.response;
			return Boolean(
				response && isTextFileResponse(response) && isHtmlPath(response.path),
			);
		},
		get inlineFileHasRenderedPreview() {
			const response = getActiveInlineFile()?.response;
			return Boolean(response && hasRenderedFilePreview(response));
		},
		get inlineFileIsText() {
			return isTextFileResponse(getActiveInlineFile()?.response);
		},
		get inlineFileExt() {
			const response = getActiveInlineFile()?.response;
			return isTextFileResponse(response)
				? (response?.name.split(".").pop()?.toLowerCase() ?? "plaintext")
				: "plaintext";
		},
		get inlineFileIsImage() {
			return Boolean(
				getActiveInlineFile()?.response?.mimeType?.startsWith("image/"),
			);
		},
		get inlineFileIsVideo() {
			return Boolean(
				getActiveInlineFile()?.response?.mimeType?.startsWith("video/"),
			);
		},
		get inlineFileDataUrl() {
			const response = getActiveInlineFile()?.response ?? null;
			if (!response || isTextFileResponse(response)) return null;
			return response.delivery === "url"
				? (response.url ?? null)
				: `data:${response.mimeType ?? "application/octet-stream"};base64,${response.content}`;
		},
		get inlineFileDownloadUrl() {
			const inlineFile = getActiveInlineFile();
			if (!inlineFile) return "";
			return getActiveFsClient().getDownloadUrl(
				inlineFile.path,
				inlineFile.response,
			);
		},
		get inlineFileDownloadName() {
			const inlineFile = getActiveInlineFile();
			return inlineFile ? (inlineFile.path.split("/").pop() ?? "download") : "";
		},
		get inlineFileEdit() {
			return getActiveInlineFile()?.edit ?? true;
		},
		set inlineFileEdit(value: boolean) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					edit: value,
				}));
		},
		get inlineFileCopied() {
			return getActiveInlineFile()?.copied ?? false;
		},
		get inlineFileZoom() {
			return getActiveInlineFile()?.zoom ?? 1;
		},
		set inlineFileZoom(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					zoom: value,
				}));
		},
		get inlineFilePanX() {
			return getActiveInlineFile()?.panX ?? 0;
		},
		set inlineFilePanX(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					panX: value,
				}));
		},
		get inlineFilePanY() {
			return getActiveInlineFile()?.panY ?? 0;
		},
		set inlineFilePanY(value: number) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					panY: value,
				}));
		},
		get inlineFileDragging() {
			return getActiveInlineFile()?.dragging ?? false;
		},
		set inlineFileDragging(value: boolean) {
			if (activeInlineFilePath)
				setInlineFileTab(activeInlineFilePath, (tab) => ({
					...tab,
					dragging: value,
				}));
		},
		get uploadPaneVisible() {
			return uploadPaneVisible;
		},
		set uploadPaneVisible(value: boolean) {
			uploadPaneVisible = value;
		},
		get uploadPaneTargetDir() {
			return uploadPaneTargetDir;
		},
		get pendingUploadFiles() {
			return pendingUploadFiles;
		},
		get pendingUploadEntries() {
			return pendingUploadEntries;
		},
		get fileTreeSourceKey() {
			return fileTreeSourceKey;
		},
		set fileTreeSourceKey(value: string) {
			fileTreeSourceKey = value;
		},
		get directoryLoadTokenByPath() {
			return directoryLoadTokenByPath;
		},
		get openFileRequestToken() {
			return fileTreeRequestToken;
		},
		get inlineFileRequestToken() {
			return inlineFileRequestToken;
		},
		setActiveFileTree,
		updateRootFsEntries,
		switchSource,
		clearRouteFile,
		resetForSpace,
		markOpenFileExternalChange,
		markInlineFileExternalChange,
		isInlineFileDirty,
		loadFileTree,
		expandDirectory,
		refreshFileTree,
		openSpaceFile,
		openFileFromUrl,
		saveOpenFile,
		closeFile,
		openInlineFile,
		closeInlineFile,
		activateInlineFile: (path: string) => {
			activeInlineFilePath = path;
			options.onActivateFilePreview?.();
		},
		closeInlineFileTab: closeInlineFile,
		goBackInlineFile,
		saveInlineFile,
		copyFileContent,
		copyInlineFileContent,
		downloadOpenFile,
		downloadInlineFile,
		downloadActiveFsFile,
		handleCreateFile,
		handleCreateCanvas,
		handleCreateDir,
		handleRenameNode,
		handleDownloadNode,
		handleDeleteNode,
		handleUploadFiles,
		handleUploadComplete,
		patchFsDirectory,
		readActiveFsFile,
		listActiveFsDir,
		markFileSavePending,
		clearFileSavePendingSoon,
		isOwnPendingFileSave,
		findFsNode,
		applyDirectoryEntries,
		markDirectoryUnloaded,
		getFileActionNode,
		renamePath,
		dispose,
	};
}

function routeDownloadUrl(spaceId: string, routeFilePath: string | null) {
	if (!routeFilePath) return "";
	return buildSpaceFileDownloadUrl(spaceId, routeFilePath);
}

function routeDownloadName(routeFilePath: string | null) {
	if (!routeFilePath) return "";
	return routeFilePath.split("/").pop() ?? "download";
}
