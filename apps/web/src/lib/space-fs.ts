import type { SpaceFsEntry } from "$lib/api";

export type SpaceFsNode = SpaceFsEntry & {
  children: SpaceFsNode[];
  isOpen: boolean;
  isLoaded: boolean;
  isLoading: boolean;
};
