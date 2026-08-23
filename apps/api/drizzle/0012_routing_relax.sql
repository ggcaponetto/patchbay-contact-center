ALTER TABLE "ring_offer" ADD COLUMN "relax_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "call_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "relaxed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD COLUMN "language" text;