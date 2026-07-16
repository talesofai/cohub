import "dotenv/config";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: "apps/api/.env", override: false });

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const connection = postgres(databaseUrl, { prepare: false, max: 1 });

type Summary = {
  blockingLabels: number;
  invalidLabelScope: number;
  invalidLabelDomain: number;
  orphanLabelSpace: number;
  invalidLabelParent: number;
  blockingAssignments: number;
  invalidAssignmentScope: number;
  invalidAssignmentDomain: number;
  invalidAssignmentLabel: number;
  invalidSessionAssignment: number;
  invalidCheckpointAssignment: number;
};

try {
  const [legacySchema] = await connection<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'v2'
        and table_name = 'labels'
        and column_name = 'scope_type'
    )
  `;
  if (!legacySchema?.exists) {
    console.log(JSON.stringify({ status: "normalized", blockingLabels: 0, blockingAssignments: 0 }, null, 2));
  } else {
    const [summary] = await connection<Summary[]>`
      with label_issues as (
        select
          label.scope_type <> 'space' or label.scope_id !~* ${UUID_PATTERN} as invalid_scope,
          label.source not in ('user', 'system') or not (
            (label.parent_id is null and label.depth = 0)
            or (label.parent_id is not null and label.depth = 1)
          ) as invalid_domain,
          not exists (
            select 1
            from v2.spaces space
            where space.id = case when label.scope_id ~* ${UUID_PATTERN} then label.scope_id::uuid end
          ) as orphan_space,
          label.parent_id is not null and not exists (
            select 1
            from v2.labels parent
            where parent.id = label.parent_id
              and parent.scope_type = label.scope_type
              and parent.scope_id = label.scope_id
          ) as invalid_parent
        from v2.labels label
      ),
      assignment_issues as (
        select
          assignment.scope_type <> 'space' or assignment.scope_id !~* ${UUID_PATTERN} as invalid_scope,
          assignment.resource_type not in ('session', 'checkpoint', 'file')
            or length(btrim(assignment.resource_ref)) = 0
            or assignment.source not in ('user', 'system') as invalid_domain,
          not exists (
            select 1
            from v2.labels label
            where label.id = assignment.label_id
              and label.scope_type = assignment.scope_type
              and label.scope_id = assignment.scope_id
          ) as invalid_label,
          assignment.resource_type = 'session' and (
            assignment.resource_ref !~* ${UUID_PATTERN}
            or not exists (
              select 1
              from v2.space_sessions session
              where session.id = case
                when assignment.resource_ref ~* ${UUID_PATTERN} then assignment.resource_ref::uuid
              end
                and session.space_id = case
                  when assignment.scope_id ~* ${UUID_PATTERN} then assignment.scope_id::uuid
                end
            )
          ) as invalid_session,
          assignment.resource_type = 'checkpoint' and (
            assignment.resource_ref !~* ${UUID_PATTERN}
            or not exists (
              select 1
              from v2.checkpoints checkpoint
              where checkpoint.id = case
                when assignment.resource_ref ~* ${UUID_PATTERN} then assignment.resource_ref::uuid
              end
                and checkpoint.space_id = case
                  when assignment.scope_id ~* ${UUID_PATTERN} then assignment.scope_id::uuid
                end
            )
          ) as invalid_checkpoint
        from v2.label_assignments assignment
      )
      select
        (select count(*)::int from label_issues where invalid_scope or invalid_domain or orphan_space or invalid_parent) as "blockingLabels",
        (select count(*)::int from label_issues where invalid_scope) as "invalidLabelScope",
        (select count(*)::int from label_issues where invalid_domain) as "invalidLabelDomain",
        (select count(*)::int from label_issues where orphan_space) as "orphanLabelSpace",
        (select count(*)::int from label_issues where invalid_parent) as "invalidLabelParent",
        (select count(*)::int from assignment_issues where invalid_scope or invalid_domain or invalid_label or invalid_session or invalid_checkpoint) as "blockingAssignments",
        (select count(*)::int from assignment_issues where invalid_scope) as "invalidAssignmentScope",
        (select count(*)::int from assignment_issues where invalid_domain) as "invalidAssignmentDomain",
        (select count(*)::int from assignment_issues where invalid_label) as "invalidAssignmentLabel",
        (select count(*)::int from assignment_issues where invalid_session) as "invalidSessionAssignment",
        (select count(*)::int from assignment_issues where invalid_checkpoint) as "invalidCheckpointAssignment"
    `;
    if (!summary) throw new Error("database returned no label integrity summary");
    const status = summary.blockingLabels === 0 && summary.blockingAssignments === 0 ? "clean" : "blocked";
    console.log(JSON.stringify({ status, ...summary }, null, 2));
    if (status === "blocked") process.exitCode = 1;
  }
} finally {
  await connection.end({ timeout: 5 });
}
