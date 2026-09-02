/** Shared payload shapes used by local App navigation and remote desktop open. */
export type NavigationLaunch = {
  search?: string;
  hash?: string;
};

export type NavigationCall = {
  method: string;
  input?: unknown;
};

export const NAVIGATION_REF_MAX_LENGTH = 2_048;
export const NAVIGATION_LAUNCH_MAX_LENGTH = 2_048;
export const NAVIGATION_METHOD_MAX_LENGTH = 64;
export const NAVIGATION_ERROR_CODE_MAX_LENGTH = 64;
export const NAVIGATION_ERROR_MESSAGE_MAX_LENGTH = 2_000;
