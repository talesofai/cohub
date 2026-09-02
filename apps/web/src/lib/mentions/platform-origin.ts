/**
 * Absolute origins that serve the Cohub web app, as a `RegExp` source fragment.
 *
 * `cohub.live` is the primary domain; `cohub.run` stays accepted so links
 * copied before the migration still convert into composer mentions.
 *
 * Deliberately free of capturing groups so callers keep their own group
 * numbering when embedding it.
 */
export const COHUB_WEB_ORIGIN_SOURCE =
	"(?:https?:\\/\\/(?:dev\\.|www\\.)?cohub\\.(?:live|run)|https?:\\/\\/localhost(?::\\d+)?)";
