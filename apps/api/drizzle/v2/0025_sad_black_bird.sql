CREATE TABLE "v2"."space_voice_lexicon_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"term" text NOT NULL,
	"term_key" varchar(120) NOT NULL,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"original_text" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "v2"."user_voice_lexicon_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"term" text NOT NULL,
	"term_key" varchar(120) NOT NULL,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"original_text" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "v2_idx_space_voice_lexicon_space_id" ON "v2"."space_voice_lexicon_entries" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_space_voice_lexicon_space_term" ON "v2"."space_voice_lexicon_entries" USING btree ("space_id","term_key");--> statement-breakpoint
CREATE INDEX "v2_idx_user_voice_lexicon_user_uuid" ON "v2"."user_voice_lexicon_entries" USING btree ("user_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_user_voice_lexicon_user_term" ON "v2"."user_voice_lexicon_entries" USING btree ("user_uuid","term_key");