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
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_runtime_id_local_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "v2"."local_agent_runtimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_runtime_session_id_local_agent_runtime_sessions_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "v2"."local_agent_runtime_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_execution_attempt_id_workspace_execution_attempts_id_fk" FOREIGN KEY ("execution_attempt_id") REFERENCES "v2"."workspace_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtime_commands" ADD CONSTRAINT "local_agent_runtime_commands_cohub_session_id_space_sessions_id_fk" FOREIGN KEY ("cohub_session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_commands_session_command" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_session_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_local_agent_runtime_commands_session_sequence" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_session_id","sequence");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_commands_attempt" ON "v2"."local_agent_runtime_commands" USING btree ("execution_attempt_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_idx_local_agent_runtime_commands_runtime_status" ON "v2"."local_agent_runtime_commands" USING btree ("runtime_id","status","updated_at");