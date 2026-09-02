CREATE TABLE "v2"."local_agent_runtime_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_session_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"sequence" bigint NOT NULL,
	"direction" varchar(20) NOT NULL,
	"method" varchar(120) NOT NULL,
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
	"replica_id" uuid,
	"user_uuid" varchar(255) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"provider_version" varchar(120) DEFAULT 'unknown' NOT NULL,
	"adapter_version" varchar(120) DEFAULT 'unknown' NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(30) DEFAULT 'offline' NOT NULL,
	"connection_epoch" bigint DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD COLUMN "runtime_id" uuid;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_events" ADD CONSTRAINT "local_agent_runtime_events_runtime_session_id_local_agent_runtime_sessions_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "v2"."local_agent_runtime_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_sessions" ADD CONSTRAINT "local_agent_runtime_sessions_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "v2"."local_agent_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD CONSTRAINT "local_agent_runtimes_replica_id_workspace_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "v2"."workspace_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_events_session_event" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_events_session_sequence" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","sequence");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_events_session_created" ON "v2"."local_agent_runtime_events" USING btree ("runtime_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_sessions_runtime_acp" ON "v2"."local_agent_runtime_sessions" USING btree ("runtime_id","acp_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_sessions_runtime_cohub" ON "v2"."local_agent_runtime_sessions" USING btree ("runtime_id","cohub_session_id");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_sessions_space_status" ON "v2"."local_agent_runtime_sessions" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtimes_space_device_provider" ON "v2"."local_agent_runtimes" USING btree ("space_id","device_id","provider");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtimes_space_status" ON "v2"."local_agent_runtimes" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtimes_device" ON "v2"."local_agent_runtimes" USING btree ("device_id","status");--> statement-breakpoint
ALTER TABLE "v2"."workspace_execution_attempts" ADD CONSTRAINT "workspace_execution_attempts_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_execution_attempts_runtime" ON "v2"."workspace_execution_attempts" USING btree ("runtime_id","created_at");