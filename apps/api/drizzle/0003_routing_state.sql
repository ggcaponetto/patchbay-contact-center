CREATE TABLE "agent_presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"since" timestamp with time zone NOT NULL,
	"call_id" text,
	"acw_until" timestamp with time zone,
	"instance_id" text NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"seq" serial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ring_offer" (
	"call_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"queue_key" text NOT NULL,
	"reason" text,
	"summary" text,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tried" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_user_id" text,
	"ring_until" timestamp with time zone,
	"give_up_at" timestamp with time zone,
	"ring_ms" integer NOT NULL,
	"fallback" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ring_offer" ADD CONSTRAINT "ring_offer_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_presence_tenant_idx" ON "agent_presence" USING btree ("tenant_id");