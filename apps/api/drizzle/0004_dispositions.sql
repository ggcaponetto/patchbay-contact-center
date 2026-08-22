ALTER TABLE "call" ADD COLUMN "disposition_code" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;