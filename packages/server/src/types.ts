import type { Db } from "./db.js"

export type Bindings = {
  DATABASE_URL: string
  API_KEY_HMAC_SECRET: string
  ENVIRONMENT?: string
  // Team-flavor extras. All OPTIONAL so the Worker still deploys with only
  // DATABASE_URL + API_KEY_HMAC_SECRET; each feature degrades gracefully when
  // its secret is absent.
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string // PKCS#8 PEM
  GITHUB_APP_INSTALLATION_ID?: string
  ANTHROPIC_API_KEY?: string
  SLACK_WEBHOOK_URL?: string
  // Comma-separated "owner/repo" list the cron scans for GitHub Projects cache
  // refresh + assignee reconciliation. Optional; falls back to repos seen in
  // live task_claims.
  CONTINUITY_REPOS?: string
}

export type Variables = {
  userId: string
  db: Db
}

export type AppEnv = {
  Bindings: Bindings
  Variables: Variables
}
