export type ChatTimelineHandle = {
	preparePrepend: () => void;
	finalizePrepend: () => void;
};

export type SessionScrollAnchor = {
	sequence: number;
	offset: number;
	updatedAt: number;
};

const AUTO_FOLLOW_THRESHOLD_PX = 60;

export function createSessionScrollController() {
	let listEl = $state<HTMLDivElement | null>(null);
	let chatTimelineRef = $state<ChatTimelineHandle | null>(null);
	let composerHeight = $state(0);
	let shouldAutoFollow = $state(true);
	let turnMarkerPositions = $state<Record<number, number>>({});
	let turnMarkerHeights = $state<Record<number, number>>({});
	let timelineScrollTop = $state(0);
	let timelineScrollHeight = $state(0);
	let timelineClientHeight = $state(0);
	let scrollAnchorBySession = $state.raw(
		new Map<string, SessionScrollAnchor>(),
	);
	let pendingRestoreSessionId = $state<string | null>(null);
	let activeAnchorRestore = $state<
		(SessionScrollAnchor & { sessionId: string }) | null
	>(null);
	let pendingTimelineMarkdownRenders = $state(0);
	let anchorRestoreWaitingForMarkdown = $state(false);
	let vimScrollFrame: number | null = null;
	let vimScrollVelocity = 0;
	let vimScrollStopTimer: ReturnType<typeof setTimeout> | null = null;
	let vimPendingGTimer: ReturnType<typeof setTimeout> | null = null;

	function loadSessionScrollAnchors(storageKey: string) {
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Record<string, SessionScrollAnchor>;
			scrollAnchorBySession = new Map(
				Object.entries(parsed).filter(([, anchor]) =>
					Boolean(
						anchor &&
							typeof anchor.sequence === "number" &&
							typeof anchor.offset === "number",
					),
				),
			);
		} catch {
			// ignore corrupt local scroll cache
		}
	}

	function persistSessionScrollAnchorsNow(storageKey: string) {
		try {
			localStorage.setItem(
				storageKey,
				JSON.stringify(Object.fromEntries(scrollAnchorBySession.entries())),
			);
		} catch {
			// ignore storage failures
		}
	}

	function setSessionScrollAnchor(
		storageKey: string,
		sessionId: string,
		anchor: SessionScrollAnchor,
	) {
		scrollAnchorBySession.set(sessionId, anchor);
		persistSessionScrollAnchorsNow(storageKey);
	}

	function getSessionScrollAnchor(sessionId: string) {
		return scrollAnchorBySession.get(sessionId);
	}

	function clearSessionScrollAnchor(storageKey: string, sessionId: string) {
		if (!scrollAnchorBySession.delete(sessionId)) return;
		persistSessionScrollAnchorsNow(storageKey);
	}

	function getMessageElementAbsoluteTop(node: HTMLElement) {
		if (!listEl) return 0;
		const containerRect = listEl.getBoundingClientRect();
		const nodeRect = node.getBoundingClientRect();
		return listEl.scrollTop + (nodeRect.top - containerRect.top);
	}

	function updateTimelineScrollMetrics() {
		if (!listEl) {
			timelineScrollTop = 0;
			timelineScrollHeight = 0;
			timelineClientHeight = 0;
			return;
		}
		timelineScrollTop = listEl.scrollTop;
		timelineScrollHeight = listEl.scrollHeight;
		timelineClientHeight = listEl.clientHeight;
	}

	function getTimelineBottomScrollTop() {
		if (!listEl) return 0;
		return Math.max(0, listEl.scrollHeight - listEl.clientHeight);
	}

	function updateAutoFollow(threshold = AUTO_FOLLOW_THRESHOLD_PX) {
		if (!listEl) return;
		const distanceFromBottom =
			listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
		shouldAutoFollow = distanceFromBottom <= threshold;
	}

	function shouldPinToBottom(options?: { immediate?: boolean }) {
		return Boolean(listEl && (options?.immediate || shouldAutoFollow));
	}

	function measureTurnMarkerPositions(turnScrollAnchorOffset: number) {
		if (!listEl) {
			turnMarkerPositions = {};
			turnMarkerHeights = {};
			updateTimelineScrollMetrics();
			return;
		}
		updateTimelineScrollMetrics();
		const scrollContainer = listEl;
		const maxScroll = Math.max(
			1,
			scrollContainer.scrollHeight - scrollContainer.clientHeight,
		);
		const railThumbHeightPercent = Math.min(
			64,
			Math.max(
				6,
				(scrollContainer.clientHeight / scrollContainer.scrollHeight) * 100,
			),
		);
		const railUsablePercent = 100 - railThumbHeightPercent;
		const toRailTopPercent = (scrollTop: number) =>
			Math.min(
				railUsablePercent,
				Math.max(0, (scrollTop / maxScroll) * railUsablePercent),
			);
		const anchors = Array.from(
			listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
		);
		const turnRanges = anchors.map((anchor, index) => {
			const sequence = Number(anchor.dataset.turnSequence);
			const start = Math.max(
				0,
				getMessageElementAbsoluteTop(anchor) - turnScrollAnchorOffset,
			);
			const nextAnchor = anchors[index + 1];
			const nextStart = nextAnchor
				? Math.max(
						0,
						getMessageElementAbsoluteTop(nextAnchor) - turnScrollAnchorOffset,
					)
				: scrollContainer.scrollHeight;
			return { anchor, sequence, start, end: Math.max(start, nextStart) };
		});
		const positions: Record<number, number> = {};
		const heights: Record<number, number> = {};
		for (const range of turnRanges) {
			if (!Number.isFinite(range.sequence)) continue;
			const turnHeight = Math.max(
				range.anchor.offsetHeight,
				range.end - range.start,
			);
			positions[range.sequence] = toRailTopPercent(range.start);
			const scrollRatio = Math.max(0.015, turnHeight / maxScroll);
			heights[range.sequence] = Math.min(22, Math.max(8, scrollRatio * 100));
		}
		turnMarkerPositions = positions;
		turnMarkerHeights = heights;
	}

	function stopVimScroll() {
		vimScrollVelocity = 0;
		if (vimScrollStopTimer) {
			clearTimeout(vimScrollStopTimer);
			vimScrollStopTimer = null;
		}
		if (vimScrollFrame != null) {
			cancelAnimationFrame(vimScrollFrame);
			vimScrollFrame = null;
		}
	}

	function runVimScrollFrame() {
		if (!listEl || vimScrollVelocity === 0) {
			stopVimScroll();
			return;
		}
		listEl.scrollTop = Math.min(
			Math.max(0, listEl.scrollHeight - listEl.clientHeight),
			Math.max(0, listEl.scrollTop + vimScrollVelocity),
		);
		vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
	}

	function scrollTimelineByLines(
		direction: 1 | -1,
		beginUserScroll: () => void,
	) {
		if (!listEl) return;
		beginUserScroll();
		vimScrollVelocity = direction * 10;
		if (vimScrollFrame == null) {
			vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
		}
		if (vimScrollStopTimer) clearTimeout(vimScrollStopTimer);
		vimScrollStopTimer = setTimeout(stopVimScroll, 110);
	}

	function clearPendingVimG() {
		if (!vimPendingGTimer) return;
		clearTimeout(vimPendingGTimer);
		vimPendingGTimer = null;
	}

	function armPendingVimG(timeoutMs = 550) {
		vimPendingGTimer = setTimeout(() => {
			vimPendingGTimer = null;
		}, timeoutMs);
	}

	function scrollTimelineToTop(
		beginUserScroll: () => void,
		setProgrammaticScrollTop: (scrollTop: number) => void,
		onScrolled?: () => void,
	) {
		if (!listEl) return;
		beginUserScroll();
		shouldAutoFollow = false;
		setProgrammaticScrollTop(0);
		requestAnimationFrame(() => onScrolled?.());
	}

	function scrollTimelineToBottom(scrollToBottomNow: () => void) {
		if (!listEl) return;
		shouldAutoFollow = true;
		stopVimScroll();
		scrollToBottomNow();
	}

	function resetSessionScrollUi() {
		turnMarkerPositions = {};
		turnMarkerHeights = {};
		timelineScrollTop = 0;
		timelineScrollHeight = 0;
		timelineClientHeight = 0;
		pendingRestoreSessionId = null;
		activeAnchorRestore = null;
		pendingTimelineMarkdownRenders = 0;
		anchorRestoreWaitingForMarkdown = false;
		shouldAutoFollow = true;
	}

	return {
		get listEl() {
			return listEl;
		},
		set listEl(value: HTMLDivElement | null) {
			listEl = value;
		},
		get chatTimelineRef() {
			return chatTimelineRef;
		},
		set chatTimelineRef(value: ChatTimelineHandle | null) {
			chatTimelineRef = value;
		},
		get composerHeight() {
			return composerHeight;
		},
		set composerHeight(value: number) {
			composerHeight = value;
		},
		get shouldAutoFollow() {
			return shouldAutoFollow;
		},
		set shouldAutoFollow(value: boolean) {
			shouldAutoFollow = value;
		},
		get turnMarkerPositions() {
			return turnMarkerPositions;
		},
		set turnMarkerPositions(value: Record<number, number>) {
			turnMarkerPositions = value;
		},
		get turnMarkerHeights() {
			return turnMarkerHeights;
		},
		set turnMarkerHeights(value: Record<number, number>) {
			turnMarkerHeights = value;
		},
		get timelineScrollTop() {
			return timelineScrollTop;
		},
		set timelineScrollTop(value: number) {
			timelineScrollTop = value;
		},
		get timelineScrollHeight() {
			return timelineScrollHeight;
		},
		set timelineScrollHeight(value: number) {
			timelineScrollHeight = value;
		},
		get timelineClientHeight() {
			return timelineClientHeight;
		},
		set timelineClientHeight(value: number) {
			timelineClientHeight = value;
		},
		get scrollAnchorBySession() {
			return scrollAnchorBySession;
		},
		set scrollAnchorBySession(value: Map<string, SessionScrollAnchor>) {
			scrollAnchorBySession = value;
		},
		get pendingRestoreSessionId() {
			return pendingRestoreSessionId;
		},
		set pendingRestoreSessionId(value: string | null) {
			pendingRestoreSessionId = value;
		},
		get activeAnchorRestore() {
			return activeAnchorRestore;
		},
		set activeAnchorRestore(value:
			| (SessionScrollAnchor & { sessionId: string })
			| null,) {
			activeAnchorRestore = value;
		},
		get pendingTimelineMarkdownRenders() {
			return pendingTimelineMarkdownRenders;
		},
		set pendingTimelineMarkdownRenders(value: number) {
			pendingTimelineMarkdownRenders = value;
		},
		get anchorRestoreWaitingForMarkdown() {
			return anchorRestoreWaitingForMarkdown;
		},
		get vimPendingGActive() {
			return Boolean(vimPendingGTimer);
		},
		set anchorRestoreWaitingForMarkdown(value: boolean) {
			anchorRestoreWaitingForMarkdown = value;
		},
		loadSessionScrollAnchors,
		persistSessionScrollAnchorsNow,
		setSessionScrollAnchor,
		getSessionScrollAnchor,
		clearSessionScrollAnchor,
		getMessageElementAbsoluteTop,
		updateTimelineScrollMetrics,
		getTimelineBottomScrollTop,
		updateAutoFollow,
		shouldPinToBottom,
		measureTurnMarkerPositions,
		stopVimScroll,
		scrollTimelineByLines,
		clearPendingVimG,
		armPendingVimG,
		scrollTimelineToTop,
		scrollTimelineToBottom,
		resetSessionScrollUi,
	};
}
