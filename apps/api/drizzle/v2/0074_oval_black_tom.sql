ALTER TABLE "v2"."local_agent_runtimes" ADD COLUMN "gateway_node_id" varchar(255);--> statement-breakpoint
ALTER TABLE "v2"."local_agent_runtimes" ADD COLUMN "gateway_ws_endpoint" text;