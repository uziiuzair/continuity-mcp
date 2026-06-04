CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_label" text NOT NULL,
	"cwd_hash" text NOT NULL,
	"project_scope" text,
	"current_focus" text,
	"claimed_issue_number" integer,
	"claimed_repo_full_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"user_id" uuid,
	"agent_session_id" uuid,
	"payload" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_key" text NOT NULL,
	"content" text NOT NULL,
	"decision_type" text DEFAULT 'other' NOT NULL,
	"project_scope" text,
	"author_user_id" uuid,
	"author_agent_session_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"repo_full_name" text,
	"tool" text NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_agent_session_id" uuid NOT NULL,
	"to_agent_session_id" uuid,
	"to_user_id" uuid,
	"project_scope" text,
	"context" text NOT NULL,
	"state" text,
	"suggested_next_actions" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_state_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_full_name" text NOT NULL,
	"project_number" integer NOT NULL,
	"snapshot" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"claimed_by_user_id" uuid NOT NULL,
	"claimed_by_agent_session_id" uuid,
	"status" text DEFAULT 'claimed' NOT NULL,
	"pr_number" integer,
	"notes" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"github_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_author_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("author_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedes_decisions_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_activity" ADD CONSTRAINT "file_activity_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_activity" ADD CONSTRAINT "file_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("from_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("to_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_claimed_by_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("claimed_by_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_user_id_idx" ON "agent_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_last_seen_idx" ON "agent_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_status_idx" ON "agent_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_user_cwd_live_uq" ON "agent_sessions" USING btree ("user_id","cwd_hash") WHERE status <> 'gone';--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "decisions_key_idx" ON "decisions" USING btree ("decision_key");--> statement-breakpoint
CREATE INDEX "decisions_status_idx" ON "decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "decisions_created_at_idx" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "file_activity_touched_at_idx" ON "file_activity" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "file_activity_session_idx" ON "file_activity" USING btree ("agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_activity_session_path_uq" ON "file_activity" USING btree ("agent_session_id","file_path");--> statement-breakpoint
CREATE INDEX "handoffs_status_idx" ON "handoffs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "handoffs_to_agent_idx" ON "handoffs" USING btree ("to_agent_session_id");--> statement-breakpoint
CREATE INDEX "handoffs_to_user_idx" ON "handoffs" USING btree ("to_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_state_cache_repo_project_uq" ON "project_state_cache" USING btree ("repo_full_name","project_number");--> statement-breakpoint
CREATE INDEX "task_claims_repo_issue_idx" ON "task_claims" USING btree ("repo_full_name","issue_number");--> statement-breakpoint
CREATE INDEX "task_claims_status_idx" ON "task_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_claims_expires_idx" ON "task_claims" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_claims_live_uq" ON "task_claims" USING btree ("repo_full_name","issue_number") WHERE status in ('claimed','in_progress','pr_open');