DROP INDEX "v2"."v2_idx_canvas_nodes_document_id";--> statement-breakpoint
DROP INDEX "v2"."v2_idx_canvas_updates_document_id";--> statement-breakpoint
ALTER TABLE "v2"."canvas_documents" ALTER COLUMN "meta" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
UPDATE "v2"."canvas_documents" SET "meta" = '{}'::jsonb WHERE "meta" IS NULL;--> statement-breakpoint
ALTER TABLE "v2"."canvas_documents" ALTER COLUMN "meta" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD COLUMN "tx_id" text;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD COLUMN "base_version" integer;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD COLUMN "request_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD COLUMN "result" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "v2"."canvas_updates"
SET
  "tx_id" = COALESCE(NULLIF("payload" ->> 'txId', ''), "id"::text),
  "base_version" = CASE
    WHEN "payload" ->> 'baseVersion' ~ '^[0-9]+$' THEN ("payload" ->> 'baseVersion')::integer
    ELSE GREATEST("version" - 1, 0)
  END;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "document_id", "tx_id"
    ORDER BY "version" DESC, "id" DESC
  ) AS duplicate_rank
  FROM "v2"."canvas_updates"
)
UPDATE "v2"."canvas_updates" AS updates
SET "tx_id" = updates."tx_id" || ':legacy:' || updates."id"::text
FROM ranked
WHERE updates."id" = ranked."id" AND ranked.duplicate_rank > 1;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ALTER COLUMN "tx_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ALTER COLUMN "base_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."canvas_documents" ADD CONSTRAINT "canvas_documents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_nodes" ADD CONSTRAINT "canvas_nodes_document_id_canvas_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "v2"."canvas_documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD CONSTRAINT "canvas_updates_document_id_canvas_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "v2"."canvas_documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_canvas_updates_document_tx" ON "v2"."canvas_updates" USING btree ("document_id","tx_id");--> statement-breakpoint
ALTER TABLE "v2"."canvas_documents" ADD CONSTRAINT "v2_chk_canvas_documents_version" CHECK ("v2"."canvas_documents"."version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_nodes" ADD CONSTRAINT "v2_chk_canvas_nodes_dimensions" CHECK ("v2"."canvas_nodes"."width" > 0 AND "v2"."canvas_nodes"."height" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_nodes" ADD CONSTRAINT "v2_chk_canvas_nodes_version" CHECK ("v2"."canvas_nodes"."version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD CONSTRAINT "v2_chk_canvas_updates_base_version" CHECK ("v2"."canvas_updates"."base_version" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."canvas_updates" ADD CONSTRAINT "v2_chk_canvas_updates_version" CHECK ("v2"."canvas_updates"."version" > "v2"."canvas_updates"."base_version") NOT VALID;
