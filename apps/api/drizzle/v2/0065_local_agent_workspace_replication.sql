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
CREATE TABLE "v2"."local_agent_runtime_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_id" uuid NOT NULL,
	"runtime_session_id" uuid NOT NULL,
	"execution_attempt_id" uuid,
	"cohub_session_id" uuid NOT NULL,
	"command_id" varchar(255) NOT NULL,
	"sequence" bigint NOT NULL,
	"method" varchar(120) NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" varchar(64) NOT NULL,
	"status" varchar(30) DEFAULT 'prepared' NOT NULL,
	"response" jsonb,
	"error_code" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."local_agent_runtime_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_session_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"sequence" bigint NOT NULL,
	"direction" varchar(20) NOT NULL,
	"method" varchar(120) NOT NULL,
	"command_id" varchar(255),
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."local_agent_runtime_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"cohub_session_id" uuid NOT NULL,
	"acp_session_id" varchar(255) NOT NULL,
	"connection_epoch" bigint NOT NULL,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"last_event_sequence" bigint DEFAULT 0 NOT NULL,
	"last_event_hash" varchar(64),
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."local_agent_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"provider_version" varchar(120) DEFAULT 'unknown' NOT NULL,
	"adapter_version" varchar(120) DEFAULT 'unknown' NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(30) DEFAULT 'offline' NOT NULL,
	"connection_epoch" bigint DEFAULT 0 NOT NULL,
	"gateway_node_id" varchar(255),
	"gateway_ws_endpoint" text,
	"last_seen_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."native_agent_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"execution_attempt_id" uuid,
	"native_agent_turn_id" uuid,
	"event_sha256" varchar(64) NOT NULL,
	"event_sequence" bigint,
	"event_type" varchar(40) NOT NULL,
	"first_ingest_id" uuid,
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
CREATE TABLE "v2"."workspace_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size" bigint NOT NULL,
	"object_key" text NOT NULL,
	"content_type" varchar(255),
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"replica_id" uuid,
	"runtime_id" uuid,
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
CREATE TABLE "v2"."workspace_snapshot_blobs" (
	"snapshot_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"manifest_inline" jsonb,
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
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_runtime_session_id_local_agent_runtime_sessions_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "v2"."local_agent_runtime_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_events" ADD CONSTRAINT "local_agent_runtime_events_runtime_session_id_local_agent_runtime_sessions_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "v2"."local_agent_runtime_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "v2"."local_agent_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_event_receipts" ADD CONSTRAINT "native_agent_event_receipts_binding_id_native_agent_sessions_id_fk" FOREIGN KEY ("binding_id") REFERENCES "v2"."native_agent_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_event_receipts" ADD CONSTRAINT "native_agent_event_receipts_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_event_receipts" ADD CONSTRAINT "native_agent_event_receipts_native_agent_turn_id_native_agent_turns_id_fk" FOREIGN KEY ("native_agent_turn_id") REFERENCES "v2"."native_agent_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_event_receipts" ADD CONSTRAINT "native_agent_event_receipts_first_ingest_id_native_agent_ingests_id_fk" FOREIGN KEY ("first_ingest_id") REFERENCES "v2"."native_agent_ingests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_binding_id_native_agent_sessions_id_fk" FOREIGN KEY ("binding_id") REFERENCES "v2"."native_agent_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_native_agent_turn_id_native_agent_turns_id_fk" FOREIGN KEY ("native_agent_turn_id") REFERENCES "v2"."native_agent_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_base_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_workspace_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_result_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("result_workspace_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_ingests" ADD CONSTRAINT "native_agent_ingests_cohub_turn_id_session_turns_id_fk" FOREIGN KEY ("cohub_turn_id") REFERENCES "v2"."session_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "v2"."local_agent_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_last_mirrored_turn_id_session_turns_id_fk" FOREIGN KEY ("last_mirrored_turn_id") REFERENCES "v2"."session_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_sessions" ADD CONSTRAINT "native_agent_sessions_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("workspace_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_binding_id_native_agent_sessions_id_fk" FOREIGN KEY ("binding_id") REFERENCES "v2"."native_agent_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_cohub_turn_id_session_turns_id_fk" FOREIGN KEY ("cohub_turn_id") REFERENCES "v2"."session_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_base_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_workspace_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_result_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("result_workspace_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."native_agent_turns" ADD CONSTRAINT "native_agent_turns_final_ingest_id_native_agent_ingests_id_fk" FOREIGN KEY ("final_ingest_id") REFERENCES "v2"."native_agent_ingests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."session_realtime_outbox" ADD CONSTRAINT "session_realtime_outbox_ingest_id_native_agent_ingests_id_fk" FOREIGN KEY ("ingest_id") REFERENCES "v2"."native_agent_ingests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."session_realtime_outbox" ADD CONSTRAINT "session_realtime_outbox_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."session_realtime_outbox" ADD CONSTRAINT "session_realtime_outbox_session_id_space_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."session_transcript_state" ADD CONSTRAINT "session_transcript_state_session_id_space_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."session_writer_leases" ADD CONSTRAINT "session_writer_leases_session_id_space_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."space_local_agent_policies" ADD CONSTRAINT "space_local_agent_policies_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."space_local_agent_policies" ADD CONSTRAINT "space_local_agent_policies_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "v2"."local_agent_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."space_workspace_policies" ADD CONSTRAINT "space_workspace_policies_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_blobs" ADD CONSTRAINT "workspace_blobs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_session_id_space_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "v2"."session_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_native_agent_turn_id_native_agent_turns_id_fk" FOREIGN KEY ("native_agent_turn_id") REFERENCES "v2"."native_agent_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_base_canonical_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_canonical_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_workspace_cycle_id_workspace_sync_cycles_id_fk" FOREIGN KEY ("workspace_cycle_id") REFERENCES "v2"."workspace_sync_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_native_ingest_id_native_agent_ingests_id_fk" FOREIGN KEY ("native_ingest_id") REFERENCES "v2"."native_agent_ingests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_result_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("result_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "v2"."local_agent_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_parent_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("parent_replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_current_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("current_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_applied_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("applied_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_last_common_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("last_common_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_replicas" ADD CONSTRAINT "workspace_replicas_active_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("active_execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshot_blobs" ADD CONSTRAINT "workspace_snapshot_blobs_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshot_blobs" ADD CONSTRAINT "workspace_snapshot_blobs_blob_id_workspace_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "v2"."workspace_blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_parent_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("parent_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_merge_parent_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("merge_parent_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_base_canonical_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_canonical_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_source_session_id_space_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_source_turn_id_session_turns_id_fk" FOREIGN KEY ("source_turn_id") REFERENCES "v2"."session_turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_source_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("source_execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_state" ADD CONSTRAINT "workspace_state_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_state" ADD CONSTRAINT "workspace_state_canonical_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("canonical_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_state" ADD CONSTRAINT "workspace_state_cloud_applied_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("cloud_applied_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_state" ADD CONSTRAINT "workspace_state_active_cycle_id_workspace_sync_cycles_id_fk" FOREIGN KEY ("active_cycle_id") REFERENCES "v2"."workspace_sync_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_state" ADD CONSTRAINT "workspace_state_active_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("active_execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_cycle_id_workspace_sync_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "v2"."workspace_sync_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_resolved_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("resolved_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_base_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_local_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("local_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_cloud_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("cloud_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_result_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("result_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_sync_cycles" ADD CONSTRAINT "workspace_sync_cycles_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_writer_leases" ADD CONSTRAINT "workspace_writer_leases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."workspace_writer_leases" ADD CONSTRAINT "workspace_writer_leases_base_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("base_snapshot_id") REFERENCES "v2"."workspace_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_devices_user_status" ON "v2"."local_agent_devices" USING btree ("user_uuid","status");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_devices_active_credential" ON "v2"."local_agent_devices" USING btree ("refresh_token_hash") WHERE "v2"."local_agent_devices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_commands_session_command" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_session_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_commands_session_sequence" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_session_id","sequence");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_commands_attempt" ON "v2"."local_agent_runtime_commands" USING btree ("execution_attempt_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_commands_runtime_status" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_events_session_event" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_events_session_sequence" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","sequence");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_events_session_created" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_events_command" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","command_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_sessions_runtime_acp" ON "v2"."local_agent_runtime_sessions" USING btree ("runtime_id","acp_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_sessions_runtime_cohub" ON "v2"."local_agent_runtime_sessions" USING btree ("runtime_id","cohub_session_id");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_sessions_space_status" ON "v2"."local_agent_runtime_sessions" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtimes_space_device_provider" ON "v2"."local_agent_runtimes" USING btree ("space_id","device_id","provider") WHERE "v2"."local_agent_runtimes"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtimes_space_status" ON "v2"."local_agent_runtimes" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtimes_device" ON "v2"."local_agent_runtimes" USING btree ("device_id","status");--> statement-breakpoint
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
CREATE UNIQUE INDEX "v2_uq_workspace_blobs_space_hash" ON "v2"."workspace_blobs" USING btree ("space_id","sha256");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_blobs_status" ON "v2"."workspace_blobs" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_execution_attempts_space_idempotency" ON "v2"."workspace_execution_attempts" USING btree ("space_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_execution_attempts_active_space" ON "v2"."workspace_execution_attempts" USING btree ("space_id") WHERE "v2"."workspace_execution_attempts"."status" in ('prepared', 'running', 'workspace_sealed', 'transcript_sealed', 'awaiting_recovery');--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_space_status" ON "v2"."workspace_execution_attempts" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_replica" ON "v2"."workspace_execution_attempts" USING btree ("replica_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_runtime" ON "v2"."workspace_execution_attempts" USING btree ("runtime_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_replicas_space" ON "v2"."workspace_replicas" USING btree ("space_id","kind","status");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_replicas_device" ON "v2"."workspace_replicas" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_replicas_cloud_space" ON "v2"."workspace_replicas" USING btree ("space_id") WHERE "v2"."workspace_replicas"."kind" = 'cloud';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_replicas_local_binding" ON "v2"."workspace_replicas" USING btree ("space_id","device_id","root_fingerprint") WHERE "v2"."workspace_replicas"."kind" = 'local' and "v2"."workspace_replicas"."status" <> 'detached';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_snapshot_blobs_snapshot_path" ON "v2"."workspace_snapshot_blobs" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshot_blobs_snapshot" ON "v2"."workspace_snapshot_blobs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshot_blobs_blob" ON "v2"."workspace_snapshot_blobs" USING btree ("blob_id");--> statement-breakpoint
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