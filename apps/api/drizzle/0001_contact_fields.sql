ALTER TABLE "call" ADD COLUMN "channel" text DEFAULT 'voice' NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "preferred_agent_id" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_preferred_agent_id_user_id_fk" FOREIGN KEY ("preferred_agent_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;