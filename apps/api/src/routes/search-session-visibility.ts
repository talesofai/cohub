import { sql } from "drizzle-orm";

export function searchSessionVisibilitySql(viewerUserUuid: string) {
  return sql`(
    sp.viewer_has_member_access
    OR sess.user_uuid = ${viewerUserUuid}
    OR EXISTS (
      SELECT 1
      FROM v2.access_policies session_policy
      WHERE session_policy.resource_type = 'session'
        AND session_policy.resource_id = sess.id
        AND (
          session_policy.signed_in_user_role IS NOT NULL
          OR session_policy.anonymous_user_role IS NOT NULL
        )
    )
    OR (
      NOT EXISTS (
        SELECT 1
        FROM v2.access_policies session_policy
        WHERE session_policy.resource_type = 'session'
          AND session_policy.resource_id = sess.id
      )
      AND EXISTS (
        SELECT 1
        FROM v2.access_policies space_policy
        WHERE space_policy.resource_type = 'space'
          AND space_policy.resource_id = sess.space_id
          AND (
            space_policy.signed_in_user_role IS NOT NULL
            OR space_policy.anonymous_user_role IS NOT NULL
          )
      )
    )
  )`;
}
