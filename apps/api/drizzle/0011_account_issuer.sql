-- Better Auth 1.7 identifies an OAuth account by (issuer, account_id). Backfill the
-- accounts that exist (Google only so far) before the column becomes mandatory.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'https://accounts.google.com' WHERE "provider_id" = 'google' AND "issuer" IS NULL;--> statement-breakpoint
UPDATE "account" SET "issuer" = "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_uidx" ON "account" USING btree ("issuer","account_id");
