ALTER TABLE "agent_sessions" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "is_worktree" boolean;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "repo_key" text;