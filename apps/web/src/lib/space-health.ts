export type SpaceHealthMeta = {
  label: string;
  dotColorClass: string;
  textColorClass: string;
  bgClass: string;
  canSend: boolean;
  canWake: boolean;
  canHibernate: boolean;
  canDelete: boolean;
};

const availableMeta: SpaceHealthMeta = {
  label: "Available",
  dotColorClass: "text-status-running",
  textColorClass: "text-status-running",
  bgClass: "bg-status-running",
  canSend: true,
  canWake: false,
  canHibernate: false,
  canDelete: false,
};


/**
 * Space is the user-facing concept; sandbox lifecycle is intentionally hidden.
 * UI should treat an existing space as available unless a product-level disabled
 * state is introduced later.
 */
export function getSpaceHealthMeta(_space?: unknown): SpaceHealthMeta {
  return availableMeta;
}
