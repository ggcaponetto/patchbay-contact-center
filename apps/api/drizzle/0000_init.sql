CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"queue_id" text NOT NULL,
	"room_name" text NOT NULL,
	"status" text NOT NULL,
	"customer_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"ai_summary" text,
	CONSTRAINT "call_room_name_unique" UNIQUE("room_name")
);
--> statement-breakpoint
CREATE TABLE "call_event" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_participant" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"identity" text NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "embed_key" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "embed_key_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_member" (
	"queue_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "queue_member_queue_id_user_id_pk" PRIMARY KEY("queue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "transcript_segment" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"speaker" text NOT NULL,
	"identity" text NOT NULL,
	"text" text NOT NULL,
	"start_ms" integer,
	"end_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_queue_id_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_event" ADD CONSTRAINT "call_event_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participant" ADD CONSTRAINT "call_participant_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participant" ADD CONSTRAINT "call_participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_key" ADD CONSTRAINT "embed_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_queue_id_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segment" ADD CONSTRAINT "transcript_segment_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "call_tenant_started_idx" ON "call" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "call_event_call_idx" ON "call_event" USING btree ("call_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_tenant_email_uidx" ON "invite" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_user_tenant_uidx" ON "membership" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_tenant_key_uidx" ON "queue" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcript_call_idx" ON "transcript_segment" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");