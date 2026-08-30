CREATE TABLE "v2"."local_agent_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"platform" varchar(80) NOT NULL,
	"daemon_version" varchar(120),
	"credential_version" integer DEFAULT 1 NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."native_agent_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"execution_attempt_id" uuid NOT NULL,
	"native_agent_turn_id" uuid,
	"event_sha256" varchar(64) NOT NULL,
	"event_sequence" bigint,
	"event_type" varchar(40) NOT NULL,
	"first_ingest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."native_agent_ingests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"native_agent_turn_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"execution_attempt_id" uuid NOT NULL,
	"workspace_policy_version" bigint NOT NULL,
	"integration_policy_version" bigint NOT NULL,
	"session_mirror_mode" varchar(30) NOT NULL,
	"native_turn_key" varchar(255) NOT NULL,
	"bundle_id" varchar(255) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"policy_mode" varchar(30) NOT NULL,
	"payload_inline" jsonb,
	"payload_object_key" text,
	"payload_sha256" varchar(64) NOT NULL,
	"payload_bytes" bigint NOT NULL,
	"payload_transport_sha256" varchar(64),
	"payload_transport_bytes" bigint,
	"base_cohub_cursor" jsonb,
	"result_cohub_cursor" jsonb,
	"base_workspace_snapshot_id" uuid,
	"result_workspace_snapshot_id" uuid,
	"cohub_session_id" uuid,
	"cohub_turn_id" uuid,
	"transcript_entry_ids" uuid[],
	"transcript_marker_entry_id" uuid,
	"transcript_visibility" varchar(20) DEFAULT 'hidden' NOT NULL,
	"status" varchar(30) DEFAULT 'prepared' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" varchar(80),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."native_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"native_session_key" varchar(255) NOT NULL,
	"cohub_session_id" uuid,
	"provider_version" varchar(120) NOT NULL,
	"adapter_version" varchar(120) NOT NULL,
	"mirror_fidelity" varchar(30) NOT NULL,
	"mirror_completeness" varchar(40) NOT NULL,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"binding_generation" bigint DEFAULT 0 NOT NULL,
	"native_cursor" jsonb,
	"cohub_cursor" jsonb,
	"last_mirrored_turn_id" uuid,
	"workspace_snapshot_id" uuid,
	"relative_cwd" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."native_agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"execution_attempt_id" uuid NOT NULL,
	"native_turn_key" varchar(255) NOT NULL,
	"provider_turn_key" varchar(255),
	"cohub_session_id" uuid,
	"cohub_turn_id" uuid,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"terminal_event_kind" varchar(40) DEFAULT 'none' NOT NULL,
	"recovery_deadline_at" timestamp with time zone,
	"base_cohub_cursor" jsonb,
	"result_cohub_cursor" jsonb,
	"base_workspace_snapshot_id" uuid,
	"result_workspace_snapshot_id" uuid,
	"relative_cwd" text,
	"first_event_sequence" bigint,
	"last_event_sequence" bigint,
	"final_ingest_id" uuid,
	"fork_operation_key" varchar(255),
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."session_realtime_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_key" varchar(500) NOT NULL,
	"ingest_id" uuid,
	"space_id" uuid NOT NULL,
	"session_id" uuid,
	"event_type" varchar(120) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"revision" bigint NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'ready' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."session_transcript_state" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"branch_epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"visible_leaf_entry_id" text,
	"visible_leaf_hash" varchar(64) DEFAULT '' NOT NULL,
	"physical_leaf_entry_id" text,
	"physical_leaf_hash" varchar(64) DEFAULT '' NOT NULL,
	"logical_entry_count" bigint DEFAULT 0 NOT NULL,
	"last_turn_sequence" integer DEFAULT 0 NOT NULL,
	"indexed_file_size" bigint DEFAULT 0 NOT NULL,
	"indexed_file_mtime" timestamp with time zone,
	"sidecar_checksum" varchar(64),
	"status" varchar(20) DEFAULT 'ready' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."session_writer_leases" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"holder_kind" varchar(30) NOT NULL,
	"holder_id" varchar(255) NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."space_local_agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"integration_policy_version" bigint DEFAULT 1 NOT NULL,
	"session_mirror_mode" varchar(30) DEFAULT 'disabled' NOT NULL,
	"workspace_mode" varchar(30) DEFAULT 'handoff' NOT NULL,
	"offline_enabled" boolean DEFAULT false NOT NULL,
	"attachment_mode" varchar(30) DEFAULT 'workspace_only' NOT NULL,
	"max_bundle_bytes" bigint DEFAULT 268435456 NOT NULL,
	"max_artifact_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"updated_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."space_workspace_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"policy_version" bigint DEFAULT 1 NOT NULL,
	"default_excludes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_excludes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitive_content_mode" varchar(40) DEFAULT 'exclude_with_warning' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid,
	"idempotency_key" varchar(255) NOT NULL,
	"executor_kind" varchar(40) NOT NULL,
	"provider" varchar(40),
	"session_mirror_mode" varchar(30),
	"integration_policy_version" bigint,
	"workspace_required" boolean DEFAULT true NOT NULL,
	"transcript_required" boolean DEFAULT true NOT NULL,
	"session_id" uuid,
	"turn_id" uuid,
	"native_agent_turn_id" uuid,
	"relative_cwd" text,
	"base_canonical_snapshot_id" uuid,
	"base_transcript_cursor" jsonb,
	"workspace_lease_epoch" bigint,
	"workspace_policy_version" bigint,
	"status" varchar(30) DEFAULT 'prepared' NOT NULL,
	"workspace_cycle_id" uuid,
	"native_ingest_id" uuid,
	"result_snapshot_id" uuid,
	"result_transcript_cursor" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" varchar(80),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"device_id" uuid,
	"user_uuid" varchar(255),
	"kind" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'attaching' NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"root_fingerprint" varchar(255),
	"parent_replica_id" uuid,
	"boundary_mode" varchar(30),
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_snapshot_id" uuid,
	"applied_snapshot_id" uuid,
	"last_common_snapshot_id" uuid,
	"active_execution_attempt_id" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"replica_generation" bigint NOT NULL,
	"parent_snapshot_id" uuid,
	"merge_parent_snapshot_id" uuid,
	"base_canonical_snapshot_id" uuid,
	"workspace_policy_version" bigint NOT NULL,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"manifest_object_key" text NOT NULL,
	"manifest_sha256" varchar(64) NOT NULL,
	"manifest_transport_sha256" varchar(64),
	"manifest_transport_bytes" bigint,
	"tree_hash" varchar(64) NOT NULL,
	"file_count" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"source" varchar(40) NOT NULL,
	"source_session_id" uuid,
	"source_turn_id" uuid,
	"source_execution_attempt_id" uuid,
	"lease_epoch" bigint,
	"status" varchar(30) DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_state" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"canonical_snapshot_id" uuid,
	"cloud_applied_snapshot_id" uuid,
	"generation" bigint DEFAULT 0 NOT NULL,
	"status" varchar(30) DEFAULT 'initializing' NOT NULL,
	"active_cycle_id" uuid,
	"active_execution_attempt_id" uuid,
	"last_writer_kind" varchar(40),
	"last_writer_id" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" varchar(40) NOT NULL,
	"base_entry" jsonb,
	"local_entry" jsonb,
	"cloud_entry" jsonb,
	"base_object_key" text,
	"local_object_key" text,
	"cloud_object_key" text,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"resolution" varchar(30),
	"resolved_snapshot_id" uuid,
	"resolved_by" varchar(255),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_sync_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"base_snapshot_id" uuid,
	"local_snapshot_id" uuid,
	"cloud_snapshot_id" uuid,
	"result_snapshot_id" uuid,
	"execution_attempt_id" uuid,
	"direction" varchar(30) NOT NULL,
	"canonical_generation_at_start" bigint DEFAULT 0 NOT NULL,
	"plan_object_key" text,
	"plan_sha256" varchar(64),
	"lease_epoch" bigint,
	"status" varchar(30) DEFAULT 'planned' NOT NULL,
	"stats" jsonb,
	"error_code" varchar(80),
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_writer_leases" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"holder_kind" varchar(40) NOT NULL,
	"holder_id" varchar(255) NOT NULL,
	"holder_user_uuid" varchar(255),
	"epoch" bigint DEFAULT 0 NOT NULL,
	"base_snapshot_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"maximum_duration_at" timestamp with time zone,
	"takeover_requires_confirmation" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_devices_user_status" ON "v2"."local_agent_devices" USING btree ("user_uuid","status");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_devices_active_credential" ON "v2"."local_agent_devices" USING btree ("refresh_token_hash") WHERE "v2"."local_agent_devices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_event_receipts_binding_event" ON "v2"."native_agent_event_receipts" USING btree ("binding_id","event_id");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_event_receipts_turn_sequence" ON "v2"."native_agent_event_receipts" USING btree ("native_agent_turn_id","event_sequence");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_event_receipts_attempt" ON "v2"."native_agent_event_receipts" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_ingests_replica_bundle" ON "v2"."native_agent_ingests" USING btree ("replica_id","bundle_id");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_ingests_turn_status" ON "v2"."native_agent_ingests" USING btree ("native_agent_turn_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_ingests_attempt" ON "v2"."native_agent_ingests" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_ingests_hidden" ON "v2"."native_agent_ingests" USING btree ("cohub_session_id","transcript_visibility","status");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_sessions_binding_identity" ON "v2"."native_agent_sessions" USING btree ("space_id","device_id","provider","native_session_key");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_sessions_space_device" ON "v2"."native_agent_sessions" USING btree ("space_id","device_id","status");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_sessions_cohub_session" ON "v2"."native_agent_sessions" USING btree ("cohub_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_turns_binding_turn" ON "v2"."native_agent_turns" USING btree ("binding_id","native_turn_key");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_turns_binding_attempt" ON "v2"."native_agent_turns" USING btree ("binding_id","execution_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_native_agent_turns_fork_operation" ON "v2"."native_agent_turns" USING btree ("fork_operation_key") WHERE "v2"."native_agent_turns"."fork_operation_key" is not null;--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_turns_session_status" ON "v2"."native_agent_turns" USING btree ("cohub_session_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_native_agent_turns_final_ingest" ON "v2"."native_agent_turns" USING btree ("final_ingest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_session_realtime_outbox_delivery_key" ON "v2"."session_realtime_outbox" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "v2_idx_session_realtime_outbox_ready" ON "v2"."session_realtime_outbox" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_session_realtime_outbox_session_revision" ON "v2"."session_realtime_outbox" USING btree ("session_id","revision");--> statement-breakpoint
CREATE INDEX "v2_idx_session_realtime_outbox_ingest" ON "v2"."session_realtime_outbox" USING btree ("ingest_id");--> statement-breakpoint
CREATE INDEX "v2_idx_session_transcript_state_status" ON "v2"."session_transcript_state" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_session_writer_leases_expiry" ON "v2"."session_writer_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "v2_idx_session_writer_leases_holder" ON "v2"."session_writer_leases" USING btree ("holder_kind","holder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_space_local_agent_policies_space_device" ON "v2"."space_local_agent_policies" USING btree ("space_id","device_id");--> statement-breakpoint
CREATE INDEX "v2_idx_space_local_agent_policies_device" ON "v2"."space_local_agent_policies" USING btree ("device_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_space_workspace_policies_space" ON "v2"."space_workspace_policies" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "v2_idx_space_workspace_policies_version" ON "v2"."space_workspace_policies" USING btree ("space_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_execution_attempts_space_idempotency" ON "v2"."workspace_execution_attempts" USING btree ("space_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_execution_attempts_active_space" ON "v2"."workspace_execution_attempts" USING btree ("space_id") WHERE "v2"."workspace_execution_attempts"."status" in ('prepared', 'running', 'workspace_sealed', 'transcript_sealed', 'awaiting_recovery');--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_space_status" ON "v2"."workspace_execution_attempts" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_replica" ON "v2"."workspace_execution_attempts" USING btree ("replica_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_replicas_space" ON "v2"."workspace_replicas" USING btree ("space_id","kind","status");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_replicas_device" ON "v2"."workspace_replicas" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_replicas_cloud_space" ON "v2"."workspace_replicas" USING btree ("space_id") WHERE "v2"."workspace_replicas"."kind" = 'cloud';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_replicas_local_binding" ON "v2"."workspace_replicas" USING btree ("space_id","device_id","root_fingerprint") WHERE "v2"."workspace_replicas"."kind" = 'local' and "v2"."workspace_replicas"."status" <> 'detached';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_snapshots_replica_generation" ON "v2"."workspace_snapshots" USING btree ("replica_id","replica_generation");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshots_replica_tree" ON "v2"."workspace_snapshots" USING btree ("replica_id","tree_hash","manifest_sha256");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshots_space_status" ON "v2"."workspace_snapshots" USING btree ("space_id","status","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshots_attempt" ON "v2"."workspace_snapshots" USING btree ("source_execution_attempt_id");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_state_status" ON "v2"."workspace_state" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_state_generation" ON "v2"."workspace_state" USING btree ("generation");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_sync_conflicts_open_cycle_path" ON "v2"."workspace_sync_conflicts" USING btree ("cycle_id","path") WHERE "v2"."workspace_sync_conflicts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_sync_conflicts_space_status" ON "v2"."workspace_sync_conflicts" USING btree ("space_id","status","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_sync_conflicts_cycle" ON "v2"."workspace_sync_conflicts" USING btree ("cycle_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_sync_cycles_active_space" ON "v2"."workspace_sync_cycles" USING btree ("space_id") WHERE "v2"."workspace_sync_cycles"."status" in ('planned', 'transferring', 'applying_cloud', 'applying_local', 'verifying');--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_sync_cycles_space_status" ON "v2"."workspace_sync_cycles" USING btree ("space_id","status","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_sync_cycles_attempt" ON "v2"."workspace_sync_cycles" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_writer_leases_expiry" ON "v2"."workspace_writer_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_writer_leases_holder" ON "v2"."workspace_writer_leases" USING btree ("holder_kind","holder_id");