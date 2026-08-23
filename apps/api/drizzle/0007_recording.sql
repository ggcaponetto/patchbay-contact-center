ALTER TABLE "call" ADD COLUMN "recording_state" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "recording_egress_id" text;