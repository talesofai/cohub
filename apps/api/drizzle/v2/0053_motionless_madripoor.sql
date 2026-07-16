SET LOCAL lock_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "v2"."labels" label
		WHERE label."scope_type" <> 'space'
			OR label."scope_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			OR label."source" NOT IN ('user', 'system')
			OR NOT (
				(label."parent_id" IS NULL AND label."depth" = 0)
				OR (label."parent_id" IS NOT NULL AND label."depth" = 1)
			)
			OR NOT EXISTS (
				SELECT 1
				FROM "v2"."spaces" space
				WHERE space."id" = CASE
					WHEN label."scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN label."scope_id"::uuid
				END
			)
			OR (
				label."parent_id" IS NOT NULL
				AND NOT EXISTS (
					SELECT 1
					FROM "v2"."labels" parent
					WHERE parent."id" = label."parent_id"
						AND parent."scope_type" = label."scope_type"
						AND parent."scope_id" = label."scope_id"
				)
			)
	) OR EXISTS (
		SELECT 1
		FROM "v2"."label_assignments" assignment
		WHERE assignment."scope_type" <> 'space'
			OR assignment."scope_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			OR assignment."resource_type" NOT IN ('session', 'checkpoint', 'file')
			OR length(btrim(assignment."resource_ref")) = 0
			OR assignment."source" NOT IN ('user', 'system')
			OR NOT EXISTS (
				SELECT 1
				FROM "v2"."labels" label
				WHERE label."id" = assignment."label_id"
					AND label."scope_type" = assignment."scope_type"
					AND label."scope_id" = assignment."scope_id"
			)
			OR (
				assignment."resource_type" = 'session'
				AND (
					assignment."resource_ref" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
					OR NOT EXISTS (
						SELECT 1
						FROM "v2"."space_sessions" session
						WHERE session."id" = CASE
							WHEN assignment."resource_ref" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN assignment."resource_ref"::uuid
						END
							AND session."space_id" = CASE
								WHEN assignment."scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN assignment."scope_id"::uuid
							END
					)
				)
			)
			OR (
				assignment."resource_type" = 'checkpoint'
				AND (
					assignment."resource_ref" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
					OR NOT EXISTS (
						SELECT 1
						FROM "v2"."checkpoints" checkpoint
						WHERE checkpoint."id" = CASE
							WHEN assignment."resource_ref" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN assignment."resource_ref"::uuid
						END
							AND checkpoint."space_id" = CASE
								WHEN assignment."scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN assignment."scope_id"::uuid
							END
					)
				)
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'label normalization is blocked by invalid legacy rows',
			HINT = 'Repair invalid scopes, hierarchy, sources, or orphan session/checkpoint assignments and retry this migration.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" RENAME COLUMN "scope_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "v2"."labels" RENAME COLUMN "scope_id" TO "space_id";--> statement-breakpoint
ALTER TABLE "v2"."labels" DROP CONSTRAINT "v2_chk_labels_depth";--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" DROP CONSTRAINT "v2_fk_label_assignments_label_scope";
--> statement-breakpoint
ALTER TABLE "v2"."labels" DROP CONSTRAINT "v2_fk_labels_parent";
--> statement-breakpoint
DROP INDEX "v2"."v2_idx_label_assignments_scope_resource";--> statement-breakpoint
DROP INDEX "v2"."v2_idx_label_assignments_scope_label";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_labels_id_scope";--> statement-breakpoint
DROP INDEX "v2"."v2_idx_labels_scope_rank";--> statement-breakpoint
DROP INDEX "v2"."v2_idx_labels_scope_parent";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_labels_scope_parent_name";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_labels_scope_system_key";--> statement-breakpoint
DROP INDEX "v2"."v2_idx_label_assignments_session_label_resource";--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid;--> statement-breakpoint
ALTER TABLE "v2"."labels" ALTER COLUMN "space_id" TYPE uuid USING "space_id"::uuid;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD COLUMN "session_id" uuid GENERATED ALWAYS AS (case when "resource_type" = 'session' then "resource_ref"::uuid end) STORED;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD COLUMN "checkpoint_id" uuid GENERATED ALWAYS AS (case when "resource_type" = 'checkpoint' then "resource_ref"::uuid end) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_checkpoints_id_space" ON "v2"."checkpoints" USING btree ("id","space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_labels_id_space" ON "v2"."labels" USING btree ("id","space_id");--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_fk_label_assignments_space" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_fk_label_assignments_label_space" FOREIGN KEY ("label_id","space_id") REFERENCES "v2"."labels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_fk_label_assignments_session_space" FOREIGN KEY ("session_id","space_id") REFERENCES "v2"."space_sessions"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_fk_label_assignments_checkpoint_space" FOREIGN KEY ("checkpoint_id","space_id") REFERENCES "v2"."checkpoints"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."labels" ADD CONSTRAINT "v2_fk_labels_space" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."labels" ADD CONSTRAINT "v2_fk_labels_parent" FOREIGN KEY ("parent_id","space_id") REFERENCES "v2"."labels"("id","space_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_idx_label_assignments_space_resource" ON "v2"."label_assignments" USING btree ("space_id","resource_type","resource_ref");--> statement-breakpoint
CREATE INDEX "v2_idx_label_assignments_space_label" ON "v2"."label_assignments" USING btree ("space_id","label_id");--> statement-breakpoint
CREATE INDEX "v2_idx_labels_space_rank" ON "v2"."labels" USING btree ("space_id","rank");--> statement-breakpoint
CREATE INDEX "v2_idx_labels_space_parent" ON "v2"."labels" USING btree ("space_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_labels_space_parent_name" ON "v2"."labels" USING btree ("space_id",coalesce("parent_id"::text, ''),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_labels_space_system_key" ON "v2"."labels" USING btree ("space_id","system_key");--> statement-breakpoint
CREATE INDEX "v2_idx_label_assignments_session_label_resource" ON "v2"."label_assignments" USING btree ("label_id","session_id") WHERE "v2"."label_assignments"."resource_type" = 'session';--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" DROP COLUMN "scope_type";--> statement-breakpoint
ALTER TABLE "v2"."labels" DROP COLUMN "scope_type";--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_chk_label_assignments_resource_type" CHECK ("v2"."label_assignments"."resource_type" in ('session', 'checkpoint', 'file'));--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_chk_label_assignments_resource_ref" CHECK (length(btrim("v2"."label_assignments"."resource_ref")) > 0);--> statement-breakpoint
ALTER TABLE "v2"."label_assignments" ADD CONSTRAINT "v2_chk_label_assignments_source" CHECK ("v2"."label_assignments"."source" in ('user', 'system'));--> statement-breakpoint
ALTER TABLE "v2"."labels" ADD CONSTRAINT "v2_chk_labels_hierarchy" CHECK (("v2"."labels"."parent_id" is null and "v2"."labels"."depth" = 0) or ("v2"."labels"."parent_id" is not null and "v2"."labels"."depth" = 1));--> statement-breakpoint
ALTER TABLE "v2"."labels" ADD CONSTRAINT "v2_chk_labels_source" CHECK ("v2"."labels"."source" in ('user', 'system'));
