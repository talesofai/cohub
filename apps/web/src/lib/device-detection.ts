import Bowser from "bowser";

export type DeviceType =
	| "bot"
	| "desktop"
	| "mobile"
	| "tablet"
	| "tv"
	| "unknown";

type NavigatorWithUserAgentData = Navigator & {
	userAgentData?: Bowser.ClientHints;
};

/** Classifies the user agent's form factor independently of touch hardware. */
export function getDeviceType(
	userAgent: string,
	clientHints?: Bowser.ClientHints,
): DeviceType {
	if (!userAgent) return "unknown";

	const type = Bowser.getParser(userAgent, clientHints).getPlatformType();
	switch (type) {
		case "bot":
		case "desktop":
		case "mobile":
		case "tablet":
		case "tv":
			return type;
		default:
			return "unknown";
	}
}

export function getCurrentDeviceType(): DeviceType {
	if (typeof window === "undefined") return "unknown";
	const navigatorWithHints = window.navigator as NavigatorWithUserAgentData;
	return getDeviceType(
		navigatorWithHints.userAgent,
		navigatorWithHints.userAgentData,
	);
}
