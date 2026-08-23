CREATE TABLE "user_skill" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"skill" text NOT NULL,
	"proficiency" integer NOT NULL,
	CONSTRAINT "user_skill_tenant_id_user_id_skill_pk" PRIMARY KEY("tenant_id","user_id","skill")
);
--> statement-breakpoint
ALTER TABLE "agent_presence" ADD COLUMN "handled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_presence" ADD COLUMN "last_offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "algorithm" text DEFAULT 'longest_idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "preferred_user_id" text;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;