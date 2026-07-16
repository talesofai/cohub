DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "v2"."access_policies" policy
		WHERE policy."resource_type" NOT IN ('space', 'session')
			OR policy."signed_in_user_role" NOT IN ('builder', 'guest')
			OR policy."anonymous_user_role" <> 'guest'
			OR (
				policy."resource_type" = 'space'
				AND NOT EXISTS (
					SELECT 1 FROM "v2"."spaces" space WHERE space."id" = policy."resource_id"
				)
			)
			OR (
				policy."resource_type" = 'session'
				AND NOT EXISTS (
					SELECT 1 FROM "v2"."space_sessions" session WHERE session."id" = policy."resource_id"
				)
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'access policy normalization is blocked by invalid legacy rows',
			HINT = 'Repair unsupported roles, resource types, or orphan resource ids and retry this migration.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "v2"."session_access_policies" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"signed_in_user_role" varchar(20),
	"anonymous_user_role" varchar(20),
	"created_by" varchar(255) NOT NULL,
	"updated_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "v2_chk_session_access_policies_signed_in_role" CHECK ("v2"."session_access_policies"."signed_in_user_role" is null or "v2"."session_access_policies"."signed_in_user_role" in ('builder', 'guest')),
	CONSTRAINT "v2_chk_session_access_policies_anonymous_role" CHECK ("v2"."session_access_policies"."anonymous_user_role" is null or "v2"."session_access_policies"."anonymous_user_role" = 'guest')
);
--> statement-breakpoint
CREATE TABLE "v2"."space_access_policies" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"signed_in_user_role" varchar(20),
	"anonymous_user_role" varchar(20),
	"created_by" varchar(255) NOT NULL,
	"updated_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "v2_chk_space_access_policies_signed_in_role" CHECK ("v2"."space_access_policies"."signed_in_user_role" is null or "v2"."space_access_policies"."signed_in_user_role" in ('builder', 'guest')),
	CONSTRAINT "v2_chk_space_access_policies_anonymous_role" CHECK ("v2"."space_access_policies"."anonymous_user_role" is null or "v2"."space_access_policies"."anonymous_user_role" = 'guest')
);
--> statement-breakpoint
ALTER TABLE "v2"."session_access_policies" ADD CONSTRAINT "v2_fk_session_access_policies_session" FOREIGN KEY ("session_id") REFERENCES "v2"."space_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2"."space_access_policies" ADD CONSTRAINT "v2_fk_space_access_policies_space" FOREIGN KEY ("space_id") REFERENCES "v2"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "v2"."session_access_policies" (
	"session_id",
	"signed_in_user_role",
	"anonymous_user_role",
	"created_by",
	"updated_by",
	"created_at",
	"updated_at"
)
SELECT
	"resource_id",
	"signed_in_user_role",
	"anonymous_user_role",
	"created_by",
	"updated_by",
	"created_at",
	"updated_at"
FROM "v2"."access_policies"
WHERE "resource_type" = 'session';--> statement-breakpoint
INSERT INTO "v2"."space_access_policies" (
	"space_id",
	"signed_in_user_role",
	"anonymous_user_role",
	"created_by",
	"updated_by",
	"created_at",
	"updated_at"
)
SELECT
	"resource_id",
	"signed_in_user_role",
	"anonymous_user_role",
	"created_by",
	"updated_by",
	"created_at",
	"updated_at"
FROM "v2"."access_policies"
WHERE "resource_type" = 'space';--> statement-breakpoint
DROP TABLE "v2"."access_policies";
