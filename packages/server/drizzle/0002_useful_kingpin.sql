CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_session_id" uuid NOT NULL,
	"to_agent_session_id" uuid NOT NULL,
	"repo_full_name" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"requires_response" boolean DEFAULT false NOT NULL,
	"related_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("from_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("to_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_to_status_idx" ON "messages" USING btree ("to_agent_session_id","status");--> statement-breakpoint
CREATE INDEX "messages_from_status_idx" ON "messages" USING btree ("from_agent_session_id","status");--> statement-breakpoint
CREATE INDEX "messages_expires_idx" ON "messages" USING btree ("expires_at");