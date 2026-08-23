DROP INDEX "queue_tenant_key_uidx";--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_tenant_key_uidx" ON "queue" USING btree ("tenant_id","key") WHERE "queue"."archived_at" is null;