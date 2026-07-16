# Agent Messaging & Enforced Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Direct messages between parallel Claude Code sessions with deterministic enforcement (collision negotiation, ack-required decisions, reply gates on edits and turn-end), per `docs/superpowers/specs/2026-07-17-agent-messaging-design.md`.

**Architecture:** One new `messages` primitive behind the `ContinuityBackend` seam. Delivery rides the existing `--prompt-sync` injection; gates are pure state-file reads in hooks (PreToolUse v2 + new Stop hook). Every block expires (default 10m) — timeout-override deadlock rule.

**Tech Stack:** TypeScript, node:sqlite (local flavor), MCP SDK, vitest, plain-ESM hook scripts. Node ≥ 22.5.

**Scope note:** This plan delivers the local flavor end-to-end plus the RemoteBackend HTTP client methods (so the interface compiles for team mode). The Worker routes / pg janitor / contract-parity extension are a follow-up plan — in team mode the new tools fail loudly until that lands. The pg *schema* + migration are included here so schema-parity checks stay green.

**Conventions to follow (read these files before starting):**
- `packages/mcp/src/backends/local.ts` — raw-SQL style, `MESSAGE_COLS`-style aliasing, `tx()`, `maybeSweep()`.
- `packages/shared/src/mappers.ts` — RowLike structural types, `toIso`/`toIsoOrNull`.
- `packages/mcp/src/tools/handoffs.ts` — tool registration style.
- `packages/mcp/src/guard.ts` / `plugin/scripts/lib/guard.mjs` — the ts↔mjs mirror convention: any change to one requires the same change in the other.
- Run all tests with Node ≥ 22.5: `cd packages/mcp && npx vitest run` (this box's default node is 24 — fine).

---

### Task 1: Shared types, args, constants, mapper

**Files:**
- Modify: `packages/shared/src/types.ts` (append after the Handoffs section)
- Modify: `packages/shared/src/backend.ts` (new args + interface methods)
- Modify: `packages/shared/src/constants.ts` (timeout default)
- Modify: `packages/shared/src/mappers.ts` (append `toMessage`)

- [ ] **Step 1: Add types** — append to `packages/shared/src/types.ts`:

```ts
// ---- Messages ----

export type MessageKind = "message" | "collision" | "decision"
export type MessageStatus = "pending" | "responded" | "dismissed"

export type Message = {
  id: string
  from_agent_session_id: string
  to_agent_session_id: string
  repo_full_name: string | null
  kind: MessageKind
  body: string
  requires_response: boolean
  related_key: string | null
  status: MessageStatus
  response: string | null
  created_at: string
  responded_at: string | null
  expires_at: string
  // Joined for display on list/pending responses.
  from_agent_label?: string
  from_user_name?: string
}
```

- [ ] **Step 2: Add backend args + methods** — in `packages/shared/src/backend.ts`, import `Message`, `MessageKind`, `MessageStatus` in the type-import block, append after `AuditRecentArgs`:

```ts
export type MessageSendArgs = {
  from_session: string
  to_session?: string
  broadcast?: boolean
  kind: MessageKind
  body: string
  requires_response?: boolean
  related_key?: string | null
  repo_full_name?: string | null
  expires_in_minutes?: number
}
export type MessageRespondArgs = { message_id: string; response: string; dismiss?: boolean }
export type MessageListArgs = {
  session_id: string
  direction?: "inbound" | "outbound"
  status?: MessageStatus
  limit?: number
}
```

and inside `interface ContinuityBackend`, after the Handoffs block:

```ts
  // ---- Messages ----
  // expires_at returned so the sender can track its own block windows (the
  // collision_sent stamp) without a second query.
  messageSend(args: MessageSendArgs): Promise<{ message_ids: string[]; delivered: number; expires_at: string }>
  messageRespond(args: MessageRespondArgs): Promise<{ ok: boolean }>
  messageList(args: MessageListArgs): Promise<{ messages: Message[] }>
  // Everything prompt-sync needs in one call: pending unexpired inbound for me,
  // plus my outbound rows resolved (responded/dismissed) in the last 30 minutes.
  messagePending(args: { session_id: string }): Promise<{ inbound: Message[]; resolved: Message[] }>
```

- [ ] **Step 3: Constant** — in `packages/shared/src/constants.ts` add:

```ts
// Default lifetime of a message / enforcement block (the timeout-override rule).
export const DEFAULT_MESSAGE_TIMEOUT_MIN = 10
```

- [ ] **Step 4: Mapper** — append to `packages/shared/src/mappers.ts` (follow the `toHandoff` pattern exactly):

```ts
type MessageRowLike = {
  id: string
  fromAgentSessionId: string
  toAgentSessionId: string
  repoFullName: string | null
  kind: MessageKind
  body: string
  requiresResponse: number | boolean
  relatedKey: string | null
  status: MessageStatus
  response: string | null
  createdAt: TimestampLike
  respondedAt: TimestampLike | null
  expiresAt: TimestampLike
  fromAgentLabel?: string | null
  fromUserName?: string | null
}

export function toMessage(r: MessageRowLike): Message {
  return {
    id: r.id,
    from_agent_session_id: r.fromAgentSessionId,
    to_agent_session_id: r.toAgentSessionId,
    repo_full_name: r.repoFullName,
    kind: r.kind,
    body: r.body,
    requires_response: Boolean(r.requiresResponse),
    related_key: r.relatedKey,
    status: r.status,
    response: r.response,
    created_at: toIso(r.createdAt),
    responded_at: toIsoOrNull(r.respondedAt),
    expires_at: toIso(r.expiresAt),
    from_agent_label: r.fromAgentLabel ?? undefined,
    from_user_name: r.fromUserName ?? undefined,
  }
}
```

Add `Message`, `MessageKind`, `MessageStatus` to the mappers' type-import list. Check `packages/shared/src/index.ts` re-exports `types.js`, `backend.js`, `mappers.js`, `constants.js` (it does — star exports; nothing to add unless exports are named individually; if named, add the new names).

- [ ] **Step 5: Typecheck** — Run: `pnpm -r typecheck`. Expected: FAILURES in `packages/mcp` only — `LocalBackend`/`RemoteBackend` don't implement the new methods yet. `packages/shared` itself must pass. (This is the interface forcing the implementations; Tasks 3–4 fix it.)

- [ ] **Step 6: Commit** — `git add packages/shared && git commit -m "feat(shared): message types, backend seam, mapper"`

---

### Task 2: Schemas (sqlite DDL + drizzle, pg + migration)

**Files:**
- Modify: `packages/shared/src/schema.sqlite.ts`
- Modify: `packages/shared/src/schema.pg.ts`
- Create: pg migration (follow the existing `0001` file's location/naming under `packages/server` — check `ls packages/server/migrations/` and copy its header style)
- Modify: `packages/shared/src/schema-parity.checks.ts` (add messages to whatever table list it asserts — read the file, mirror the existing per-table entries)

- [ ] **Step 1: Drizzle table (sqlite)** — in `schema.sqlite.ts`, after the `handoffs` table:

```ts
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    fromAgentSessionId: text("from_agent_session_id").notNull(),
    toAgentSessionId: text("to_agent_session_id").notNull(),
    repoFullName: text("repo_full_name"),
    kind: text("kind", { enum: ["message", "collision", "decision"] }).notNull(),
    body: text("body").notNull(),
    requiresResponse: integer("requires_response").notNull().default(0),
    relatedKey: text("related_key"),
    status: text("status", { enum: ["pending", "responded", "dismissed"] })
      .notNull()
      .default("pending"),
    response: text("response"),
    createdAt: text("created_at").notNull(),
    respondedAt: text("responded_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("messages_to_status_idx").on(t.toAgentSessionId, t.status),
    index("messages_from_status_idx").on(t.fromAgentSessionId, t.status),
    index("messages_expires_idx").on(t.expiresAt),
  ],
)
```

Add `export type MessageRow = typeof messages.$inferSelect` next to the other Row exports, and append to `SQLITE_DDL`:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_session_id TEXT NOT NULL,
  to_agent_session_id TEXT NOT NULL,
  repo_full_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message','collision','decision')),
  body TEXT NOT NULL,
  requires_response INTEGER NOT NULL DEFAULT 0,
  related_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','responded','dismissed')),
  response TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_status_idx ON messages (to_agent_session_id, status);
CREATE INDEX IF NOT EXISTS messages_from_status_idx ON messages (from_agent_session_id, status);
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at);
```

- [ ] **Step 2: pg table** — mirror in `schema.pg.ts` using that file's dialect (read the `handoffs` pg definition, copy its column style: `boolean(...)` for requires_response, `timestamp`/`text` per that file's convention for the other timestamp columns — match whatever handoffs uses). Same three indexes. `requiresResponse` is a real boolean in pg — the mapper already accepts `number | boolean`.

- [ ] **Step 3: pg migration `0002`** — new migration file with `CREATE TABLE IF NOT EXISTS messages (...)` translated to pg types (BOOLEAN for requires_response, TIMESTAMPTZ if `0001`/schema use it — match `0001`'s style) + the three indexes.

- [ ] **Step 4: Parity check** — extend `schema-parity.checks.ts` with a messages entry, exactly like the existing tables' entries.

- [ ] **Step 5: Verify** — Run: `pnpm -r typecheck && cd packages/mcp && npx vitest run src/backends/local.test.ts`. Expected: typecheck still fails only on the missing backend methods; existing local tests PASS (DDL is additive; opening the DB creates the table).

- [ ] **Step 6: Commit** — `git commit -am "feat(schema): messages table (sqlite + pg + migration 0002)"`

---

### Task 3: LocalBackend messages (TDD)

**Files:**
- Modify: `packages/mcp/src/backends/local.ts`
- Test: `packages/mcp/src/backends/local.test.ts` (append; reuse that file's existing helpers for opening a temp DB and checking in sessions — read its top before writing)

- [ ] **Step 1: Write failing tests** — append to `local.test.ts` (adapt the setup helper names to the file's existing ones):

```ts
describe("messages", () => {
  it("sends a direct message with computed expiry and lists it inbound", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "cwd-a" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "cwd-b" })
    const sent = await backend.messageSend({
      from_session: a.session_id,
      to_session: b.session_id,
      kind: "message",
      body: "which auth lib?",
      requires_response: true,
    })
    expect(sent.delivered).toBe(1)
    const { inbound } = await backend.messagePending({ session_id: b.session_id })
    expect(inbound).toHaveLength(1)
    expect(inbound[0]?.body).toBe("which auth lib?")
    expect(inbound[0]?.requires_response).toBe(true)
    expect(inbound[0]?.from_agent_label).toBe("a")
    expect(new Date(inbound[0]!.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("broadcast fans out to active sessions only, excluding the sender", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "cwd-a" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "cwd-b" })
    const c = await backend.checkin({ agent_label: "c", cwd_hash: "cwd-c" })
    await backend.checkout({ session_id: c.session_id })
    const sent = await backend.messageSend({
      from_session: a.session_id,
      broadcast: true,
      kind: "decision",
      body: "ack me",
      requires_response: true,
    })
    expect(sent.delivered).toBe(1) // only b: c is gone, a is the sender
    expect((await backend.messagePending({ session_id: b.session_id })).inbound).toHaveLength(1)
  })

  it("respond and dismiss resolve a message exactly once", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "cwd-a" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "cwd-b" })
    const { message_ids } = await backend.messageSend({
      from_session: a.session_id, to_session: b.session_id, kind: "message", body: "q",
    })
    const id = message_ids[0]!
    expect((await backend.messageRespond({ message_id: id, response: "answer" })).ok).toBe(true)
    expect((await backend.messageRespond({ message_id: id, response: "again" })).ok).toBe(false)
    const { resolved } = await backend.messagePending({ session_id: a.session_id })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.status).toBe("responded")
    expect(resolved[0]?.response).toBe("answer")
  })

  it("expired messages drop out of pending inbound", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "cwd-a" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "cwd-b" })
    await backend.messageSend({
      from_session: a.session_id, to_session: b.session_id, kind: "message",
      body: "stale", expires_in_minutes: -1, // already expired
    })
    expect((await backend.messagePending({ session_id: b.session_id })).inbound).toHaveLength(0)
  })

  it("messageList filters by direction and status", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "cwd-a" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "cwd-b" })
    await backend.messageSend({ from_session: a.session_id, to_session: b.session_id, kind: "message", body: "one" })
    const out = await backend.messageList({ session_id: a.session_id, direction: "outbound" })
    expect(out.messages).toHaveLength(1)
    const inbNone = await backend.messageList({ session_id: a.session_id, direction: "inbound" })
    expect(inbNone.messages).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify RED** — `npx vitest run src/backends/local.test.ts`. Expected: FAIL — `backend.messageSend is not a function`.

- [ ] **Step 3: Implement** — in `local.ts`: add `Message`, `MessageSendArgs`, `MessageRespondArgs`, `MessageListArgs`, `DEFAULT_MESSAGE_TIMEOUT_MIN`, `toMessage` to the shared import; add the column projection near the other `*_COLS`:

```ts
const MESSAGE_COLS =
  "m.id, m.from_agent_session_id AS fromAgentSessionId, m.to_agent_session_id AS toAgentSessionId, m.repo_full_name AS repoFullName, m.kind, m.body, m.requires_response AS requiresResponse, m.related_key AS relatedKey, m.status, m.response, m.created_at AS createdAt, m.responded_at AS respondedAt, m.expires_at AS expiresAt, s.agent_label AS fromAgentLabel"
const MESSAGE_JOIN = "FROM messages m LEFT JOIN agent_sessions s ON s.id = m.from_agent_session_id"
```

and the methods (inside the class, after the Handoffs section):

```ts
  // ---- Messages ----

  async messageSend(args: MessageSendArgs): Promise<{ message_ids: string[]; delivered: number; expires_at: string }> {
    this.maybeSweep()
    if (!args.to_session && !args.broadcast) throw new Error("to_session or broadcast required")
    const now = Date.now()
    const timeoutMin = args.expires_in_minutes ?? DEFAULT_MESSAGE_TIMEOUT_MIN
    const expiresAt = new Date(now + timeoutMin * 60_000).toISOString()
    const recipients = args.broadcast
      ? this.all(
          `SELECT id FROM agent_sessions WHERE status <> 'gone' AND last_seen_at >= ? AND id <> ?`,
          isoFrom(DEFAULT_LIST_ACTIVE_WINDOW_S * 1000, now),
          args.from_session,
        ).map((r) => r.id as string)
      : [args.to_session as string]
    const ids: string[] = []
    this.tx(() => {
      for (const to of recipients) {
        const id = randomUUID()
        ids.push(id)
        this.run(
          `INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, repo_full_name, kind, body, requires_response, related_key, status, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
          id, args.from_session, to, args.repo_full_name ?? null, args.kind,
          args.body, args.requires_response ? 1 : 0, args.related_key ?? null,
          nowIso(), expiresAt,
        )
      }
    })
    return { message_ids: ids, delivered: ids.length, expires_at: expiresAt }
  }

  async messageRespond(args: MessageRespondArgs): Promise<{ ok: boolean }> {
    const changes = this.run(
      `UPDATE messages SET status = ?, response = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
      args.dismiss ? "dismissed" : "responded", args.response, nowIso(), args.message_id,
    )
    return { ok: changes > 0 }
  }

  async messageList(args: MessageListArgs): Promise<{ messages: Message[] }> {
    const dirSql =
      args.direction === "outbound" ? "m.from_agent_session_id = ?"
      : args.direction === "inbound" ? "m.to_agent_session_id = ?"
      : "(m.from_agent_session_id = ? OR m.to_agent_session_id = ?)"
    const dirParams = args.direction ? [args.session_id] : [args.session_id, args.session_id]
    const statusSql = args.status ? " AND m.status = ?" : ""
    const params = args.status ? [...dirParams, args.status] : dirParams
    const rows = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN} WHERE ${dirSql}${statusSql} ORDER BY m.created_at DESC LIMIT ?`,
      ...params, Math.min(args.limit ?? 50, 200),
    )
    return { messages: rows.map((r) => toMessage(this.withUserName(r))) }
  }

  async messagePending(args: { session_id: string }): Promise<{ inbound: Message[]; resolved: Message[] }> {
    const now = nowIso()
    const inbound = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN}
       WHERE m.to_agent_session_id = ? AND m.status = 'pending' AND m.expires_at > ?
       ORDER BY m.created_at ASC LIMIT 20`,
      args.session_id, now,
    )
    const resolved = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN}
       WHERE m.from_agent_session_id = ? AND m.status <> 'pending' AND m.responded_at > ?
       ORDER BY m.responded_at ASC LIMIT 20`,
      args.session_id, isoFrom(30 * 60_000),
    )
    return {
      inbound: inbound.map((r) => toMessage(this.withUserName(r))),
      resolved: resolved.map((r) => toMessage(this.withUserName(r))),
    }
  }

  // Local flavor has a single implicit user; stamp its name for display parity
  // with the team flavor's join.
  private withUserName(r: Row): Row {
    return { ...r, fromUserName: this.identity.userName }
  }
```

(`isoFrom` and `nowIso` already exist in this file/imports. If `maybeSweep()` prunes tables, add `DELETE FROM messages WHERE created_at < ?` with the same prune window used for file_activity — read `maybeSweep` and mirror.)

- [ ] **Step 4: Run to verify GREEN** — `npx vitest run src/backends/local.test.ts`. Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit** — `git commit -am "feat(local): messages send/respond/list/pending with fan-out and lazy expiry"`

---

### Task 4: RemoteBackend client methods

**Files:**
- Modify: `packages/mcp/src/backends/remote.ts`

- [ ] **Step 1: Implement** — add the four methods after the Handoffs section, following the existing `post`/`get` helpers (routes land in the follow-up server plan; these 404 loudly until then, which is the documented team-mode behavior for this release):

```ts
  // ---- Messages ----

  messageSend(args: MessageSendArgs): Promise<{ message_ids: string[]; delivered: number; expires_at: string }> {
    return this.post("/messages/send", args)
  }

  messageRespond(args: MessageRespondArgs): Promise<{ ok: boolean }> {
    return this.post("/messages/respond", args)
  }

  messageList(args: MessageListArgs): Promise<{ messages: Message[] }> {
    return this.get("/messages/list", args)
  }

  messagePending(args: { session_id: string }): Promise<{ inbound: Message[]; resolved: Message[] }> {
    return this.get("/messages/pending", args)
  }
```

Add `Message`, `MessageSendArgs`, `MessageRespondArgs`, `MessageListArgs` to the type imports.

- [ ] **Step 2: Verify** — `pnpm -r typecheck`. Expected: PASS everywhere now (interface fully implemented).

- [ ] **Step 3: Commit** — `git commit -am "feat(remote): message client methods (server routes in follow-up)"`

---

### Task 5: State-file shape + guard v2 decision functions (TDD)

**Files:**
- Modify: `packages/mcp/src/state.ts`
- Modify: `packages/mcp/src/guard.ts`
- Test: `packages/mcp/src/guard.test.ts` (append)

- [ ] **Step 1: State types** — in `state.ts`, extend the import and `SessionState`:

```ts
import type { PendingInboundEntry } from "./guard.js"
// ... inside SessionState, after collision_warned:
  pending_inbound?: PendingInboundEntry[] | null
  collision_sent?: Record<string, { message_id: string; expires_at: string; status: string }> | null
  message_warned?: string[] | null
```

- [ ] **Step 2: Write failing tests** — append to `guard.test.ts`:

```ts
describe("guard v2: collision negotiation", () => {
  const contested = [entry()] // entry() helper from the top of this file: path src/app.ts, fresh
  it("mode off allows; mode warn keeps warn-once", () => {
    expect(collisionDecisionV2({ mode: "off", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: {}, nowMs: NOW }).action).toBe("allow")
    const warn = collisionDecisionV2({ mode: "warn", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: {}, nowMs: NOW })
    expect(warn.action).toBe("deny")
    const again = collisionDecisionV2({ mode: "warn", entries: contested, relPath: "src/app.ts", warned: ["src/app.ts"], collisionSent: {}, nowMs: NOW })
    expect(again.action).toBe("allow")
  })
  it("negotiate: denies with a message_send instruction until a collision message exists", () => {
    const d = collisionDecisionV2({ mode: "negotiate", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: {}, nowMs: NOW })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.reason).toContain("message_send")
  })
  it("negotiate: pending unexpired collision message keeps denying with countdown", () => {
    const sent = { "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "pending" } }
    const d = collisionDecisionV2({ mode: "negotiate", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: sent, nowMs: NOW })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.reason).toContain("expires")
  })
  it("negotiate: responded or expired collision message allows", () => {
    const responded = { "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "responded" } }
    expect(collisionDecisionV2({ mode: "negotiate", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: responded, nowMs: NOW }).action).toBe("allow")
    const expired = { "src/app.ts": { message_id: "m1", expires_at: iso(-1000), status: "pending" } }
    expect(collisionDecisionV2({ mode: "negotiate", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: expired, nowMs: NOW }).action).toBe("allow")
  })
})

describe("guard v2: ack gate", () => {
  const item = { message_id: "m1", from_label: "alpha", from_user: "Ann", body: "ack me", kind: "decision", related_key: "orm", requires_response: true, expires_at: iso(5 * 60_000) }
  it("denies once listing unanswered required items, then passes", () => {
    const d = ackGateDecision({ pendingInbound: [item], messageWarned: [], nowMs: NOW })
    expect(d.warn).toBe(true)
    if (d.warn) {
      expect(d.reason).toContain("m1")
      const again = ackGateDecision({ pendingInbound: [item], messageWarned: d.warned, nowMs: NOW })
      expect(again.warn).toBe(false)
    }
  })
  it("ignores expired and non-required items", () => {
    const expired = { ...item, expires_at: iso(-1000) }
    const fyi = { ...item, message_id: "m2", requires_response: false }
    expect(ackGateDecision({ pendingInbound: [expired, fyi], messageWarned: [], nowMs: NOW }).warn).toBe(false)
  })
})

describe("guard v2: stop gate", () => {
  const item = { message_id: "m1", from_label: "alpha", from_user: "Ann", body: "ack me", kind: "message", related_key: null, requires_response: true, expires_at: iso(5 * 60_000) }
  it("blocks on fresh required items, never when stop_hook_active", () => {
    expect(stopGateDecision({ pendingInbound: [item], stopHookActive: false, nowMs: NOW }).block).toBe(true)
    expect(stopGateDecision({ pendingInbound: [item], stopHookActive: true, nowMs: NOW }).block).toBe(false)
    expect(stopGateDecision({ pendingInbound: [{ ...item, expires_at: iso(-1) }], stopHookActive: false, nowMs: NOW }).block).toBe(false)
  })
})

describe("parseGuardMode", () => {
  it("maps legacy booleans and defaults to negotiate", () => {
    expect(parseGuardMode(undefined)).toBe("negotiate")
    expect(parseGuardMode("true")).toBe("negotiate")
    expect(parseGuardMode("false")).toBe("off")
    expect(parseGuardMode("off")).toBe("off")
    expect(parseGuardMode("warn")).toBe("warn")
    expect(parseGuardMode("negotiate")).toBe("negotiate")
  })
})
```

Update the test file's guard import to include the new names.

- [ ] **Step 3: Run to verify RED** — `npx vitest run src/guard.test.ts`. Expected: FAIL — new functions not exported.

- [ ] **Step 4: Implement in `guard.ts`** (keep the existing `collisionDecision`/`buildOthersCache` untouched — the mjs mirror still uses the same logic underneath):

```ts
export type GuardMode = "negotiate" | "warn" | "off"

export function parseGuardMode(raw: string | undefined): GuardMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "off" || v === "false" || v === "0") return "off"
  if (v === "warn") return "warn"
  return "negotiate"
}

export type PendingInboundEntry = {
  message_id: string
  from_label: string
  from_user: string
  body: string
  kind: string
  related_key: string | null
  requires_response: boolean
  expires_at: string
}

export type CollisionSentMap = Record<string, { message_id: string; expires_at: string; status: string }>

type GuardResult = { action: "allow" } | { action: "deny"; reason: string; warned?: string[] }

function minutesLeft(expiresAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / 60_000))
}

export function collisionDecisionV2(args: {
  mode: GuardMode
  entries: OthersActivityEntry[] | null | undefined
  relPath: string
  warned: string[] | null | undefined
  collisionSent: CollisionSentMap | null | undefined
  nowMs: number
  windowMs?: number
}): GuardResult {
  const { mode, entries, relPath, nowMs, windowMs } = args
  if (mode === "off") return { action: "allow" }

  const base = collisionDecision({ entries, relPath, warned: mode === "warn" ? args.warned : [], nowMs, windowMs })
  if (!base.warn) {
    // No fresh contest — but for warn mode, collisionDecision also returns
    // false for already-warned paths, which is the correct allow.
    if (mode === "negotiate") {
      const contested = (entries ?? []).some((e) => {
        const t = new Date(e?.touched_at ?? "").getTime()
        return e?.path === relPath && Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= (windowMs ?? 30 * 60_000)
      })
      if (!contested) return { action: "allow" }
      // fall through: contested, decide by the sent-message state below
    } else {
      return { action: "allow" }
    }
  } else if (mode === "warn") {
    return { action: "deny", reason: base.reason, warned: base.warned }
  }

  // negotiate mode, path contested
  const sent = args.collisionSent?.[relPath]
  const other = (entries ?? []).find((e) => e?.path === relPath)
  if (!sent || sent.status === "dismissed") {
    return {
      action: "deny",
      reason:
        `Continuity: ${other?.agent_label} (${other?.user_name}) is working in ${relPath}. ` +
        `Coordinate first: message_send({ to_session: "${other?.session_id}", about_file: "${relPath}", body: "<what you want to change>" }). ` +
        `The block lifts when they respond, or expires on its own — pick other work meanwhile.`,
    }
  }
  if (sent.status === "responded") return { action: "allow" }
  if (new Date(sent.expires_at).getTime() <= nowMs) return { action: "allow" } // timeout override
  return {
    action: "deny",
    reason:
      `Continuity: still awaiting a response on ${relPath} (expires in ${minutesLeft(sent.expires_at, nowMs)}m). ` +
      `Work elsewhere until then; the block lifts automatically on response or expiry.`,
  }
}

export function ackGateDecision(args: {
  pendingInbound: PendingInboundEntry[] | null | undefined
  messageWarned: string[] | null | undefined
  nowMs: number
}): { warn: false } | { warn: true; reason: string; warned: string[] } {
  const warned = Array.isArray(args.messageWarned) ? args.messageWarned : []
  const due = (args.pendingInbound ?? []).filter(
    (m) =>
      m?.requires_response &&
      new Date(m.expires_at).getTime() > args.nowMs &&
      !warned.includes(m.message_id),
  )
  if (due.length === 0) return { warn: false }
  const list = due
    .slice(0, 5)
    .map((m) => `${m.message_id} from ${m.from_label}: "${m.body.slice(0, 80)}"`)
    .join("; ")
  return {
    warn: true,
    reason:
      `Continuity: ${due.length} message(s) require your response before more edits — ${list}. ` +
      `Use message_respond(id, response) or message_dismiss(id, reason); they expire on their own otherwise. ` +
      `Retry the edit to proceed.`,
    warned: [...warned, ...due.map((m) => m.message_id)].slice(-100),
  }
}

export function stopGateDecision(args: {
  pendingInbound: PendingInboundEntry[] | null | undefined
  stopHookActive: boolean
  nowMs: number
}): { block: false } | { block: true; reason: string } {
  if (args.stopHookActive) return { block: false } // at most one block per stop chain
  const due = (args.pendingInbound ?? []).filter(
    (m) => m?.requires_response && new Date(m.expires_at).getTime() > args.nowMs,
  )
  if (due.length === 0) return { block: false }
  const list = due
    .slice(0, 5)
    .map((m) => `message_respond("${m.message_id}", …) — from ${m.from_label}: "${m.body.slice(0, 80)}"`)
    .join("; ")
  return {
    block: true,
    reason: `Continuity: before ending the turn, answer or dismiss pending message(s): ${list}. Use message_dismiss(id, reason) if a response isn't warranted.`,
  }
}
```

- [ ] **Step 5: Run to verify GREEN** — `npx vitest run src/guard.test.ts`. Expected: PASS (old + new).

- [ ] **Step 6: Commit** — `git commit -am "feat(guard): negotiate/warn/off modes, ack gate, stop gate"`

---

### Task 6: Delta rendering for messages (TDD)

**Files:**
- Modify: `packages/mcp/src/deltas.ts`
- Test: `packages/mcp/src/deltas.test.ts` (append)

- [ ] **Step 1: Write failing tests** — append to `deltas.test.ts` (a `message()` fixture helper mirroring the others):

```ts
function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1", from_agent_session_id: "s2", to_agent_session_id: "s1",
    repo_full_name: "o/r", kind: "message", body: "which auth lib?",
    requires_response: true, related_key: null, status: "pending",
    response: null, created_at: iso(-30_000), responded_at: null,
    expires_at: iso(8 * 60_000), from_agent_label: "alpha", from_user_name: "Ann",
    ...overrides,
  }
}

describe("computeDeltas: messages", () => {
  it("announces new inbound messages once, with respond instruction and expiry", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = { ...empty, messages: { inbound: [message()], resolved: [] } }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("alpha (Ann)")
    expect(first.text).toContain("message_respond(m1)")
    expect(first.text).toContain("response required")
    expect(computeDeltas(first.memory, data, NOW).text).toBeNull()
  })
  it("announces resolutions of my outbound once", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const resolved = message({ id: "m9", status: "responded", response: "use better-auth", responded_at: iso(-1000), from_agent_label: "beta" })
    const data = { ...empty, messages: { inbound: [], resolved: [resolved] } }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("use better-auth")
    expect(computeDeltas(first.memory, data, NOW).text).toBeNull()
  })
  it("labels decision-ack requests distinctly", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const ack = message({ kind: "decision", related_key: "orm", body: "Decision [orm]: use Drizzle" })
    const { text } = computeDeltas(seeded, { ...empty, messages: { inbound: [ack], resolved: [] } }, NOW)
    expect(text).toContain("requires your ack")
  })
})
```

Also update the `empty` fixture to `const empty = { active: [], activity: [], decisions: [], handoffs: [], messages: { inbound: [], resolved: [] }, repoFullName: null }` and fix any existing tests that construct data objects (spread `...empty` covers them).

- [ ] **Step 2: RED** — `npx vitest run src/deltas.test.ts`. Expected: FAIL (SnapshotData has no `messages`).

- [ ] **Step 3: Implement in `deltas.ts`** — extend the types and rendering:

```ts
// SnapshotData gains:
  messages: { inbound: Message[]; resolved: Message[] }
// DeltaMemory gains:
  known_inbound: string[]
  known_resolved: string[]
```

Seeding (`!memory` branch) records both id lists via `remember`. Delta branch:

```ts
  const newInbound = messages.inbound.filter((m) => !memory.known_inbound.includes(m.id))
  const newResolved = messages.resolved.filter((m) => !memory.known_resolved.includes(m.id))
```

include both in the "nothing changed" check and `nextMemory`, and render after handoffs:

```ts
  for (const m of newInbound.slice(0, 5)) {
    const who = `${m.from_agent_label ?? "another session"} (${m.from_user_name ?? "?"})`
    if (m.kind === "decision") {
      lines.push(`- Decision [${m.related_key}] requires your ack → message_respond(${m.id})`)
    } else {
      const req = m.requires_response ? ` [response required, expires in ${Math.max(1, Math.ceil((new Date(m.expires_at).getTime() - nowMs) / 60_000))}m]` : ""
      lines.push(`- Message from ${who}: "${oneLine(m.body)}" → respond via message_respond(${m.id})${req}`)
    }
  }
  for (const m of newResolved.slice(0, 5)) {
    const verb = m.status === "dismissed" ? "dismissed your message" : "responded"
    const re = m.kind === "collision" && m.related_key ? ` (re: your collision on ${m.related_key})` : ""
    lines.push(`- ${m.from_agent_label ?? "session"}: ${verb}: "${oneLine(m.response ?? "")}"${re}`)
  }
```

Note: `resolved` rows are MY outbound — display name should be the *recipient's*; the local backend joins the FROM label only. Keep the sender-join for inbound and accept the from-label here being mine; to avoid confusion render resolved lines without a name when `m.from_agent_session_id` is me is NOT detectable here — simplest correct fix: render resolved lines as `- Response received: "…" (re: …)` with no name. Implement that (drop the label from resolved lines).

- [ ] **Step 4: GREEN** — `npx vitest run src/deltas.test.ts` (adjust the resolved-line assertion to the final format: expect `Response received` + the body). Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(deltas): message delivery lines with announce-once"`

---

### Task 7: Tools — messages.ts + decision requires_ack + ToolContext.cwdHash

**Files:**
- Create: `packages/mcp/src/tools/messages.ts`
- Modify: `packages/mcp/src/tools/util.ts` (ToolContext gains `cwdHash: string`)
- Modify: `packages/mcp/src/tools/decisions.ts` (`requires_ack` on decision_write)
- Modify: `packages/mcp/src/index.ts` (register + pass cwdHash)

- [ ] **Step 1: ToolContext** — in `util.ts` add `cwdHash: string` to `ToolContext`; in `index.ts` `runServer`, construct `const toolContext: ToolContext = { backend, getSessionId: () => sessionId, repoFullName, mode, cwdHash }`.

- [ ] **Step 2: messages.ts** — create with this content (state updates keep gates correct within a turn):

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { readState, writeState } from "../state.js"
import { type ToolContext, asText } from "./util.js"

// Direct messages between sessions. Sending with about_file marks collision
// coordination and stamps the state file so the PreToolUse guard tracks it;
// responding/dismissing prunes the pending-inbound cache so the ack/stop gates
// release without waiting for the next prompt-sync.
export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "message_send",
    {
      title: "Send a message to another session",
      description:
        "Message another live session (to_session) or broadcast to all. Set about_file (repo-relative path) when coordinating a file collision — the edit block on that file lifts when they respond or the message expires. Delivery: the recipient sees it on their next prompt.",
      inputSchema: {
        to_session: z.string().optional(),
        broadcast: z.boolean().optional(),
        body: z.string(),
        requires_response: z.boolean().optional(),
        about_file: z.string().optional().describe("Repo-relative path of a contested file."),
      },
    },
    async (args) => {
      const from = ctx.getSessionId()
      if (!from) return asText({ ok: false, reason: "no_active_session" })
      if (!args.to_session === !args.broadcast)
        return asText({ ok: false, reason: "exactly one of to_session / broadcast required" })
      const result = await ctx.backend.messageSend({
        from_session: from,
        to_session: args.to_session,
        broadcast: args.broadcast,
        kind: args.about_file ? "collision" : "message",
        body: args.body,
        requires_response: args.about_file ? true : (args.requires_response ?? false),
        related_key: args.about_file ?? null,
        repo_full_name: ctx.repoFullName,
      })
      if (args.about_file && result.message_ids[0]) {
        const state = readState(ctx.cwdHash)
        if (state) {
          writeState(ctx.cwdHash, {
            ...state,
            collision_sent: {
              ...(state.collision_sent ?? {}),
              [args.about_file]: {
                message_id: result.message_ids[0],
                expires_at: result.expires_at,
                status: "pending",
              },
            },
          })
        }
      }
      return asText(result)
    },
  )

  server.registerTool(
    "message_list",
    {
      title: "List your messages",
      description: "Inbox/outbox for this session, optionally filtered by direction or status.",
      inputSchema: {
        direction: z.enum(["inbound", "outbound"]).optional(),
        status: z.enum(["pending", "responded", "dismissed"]).optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const session = ctx.getSessionId()
      if (!session) return asText({ ok: false, reason: "no_active_session" })
      return asText(await ctx.backend.messageList({ ...args, session_id: session }))
    },
  )

  const resolveLocally = (messageId: string): void => {
    const state = readState(ctx.cwdHash)
    if (!state) return
    writeState(ctx.cwdHash, {
      ...state,
      pending_inbound: (state.pending_inbound ?? []).filter((m) => m.message_id !== messageId),
    })
  }

  server.registerTool(
    "message_respond",
    {
      title: "Respond to a message",
      description:
        "Answer a pending message (also how you ack a decision). Clears any edit/turn-end gate it was holding.",
      inputSchema: { message_id: z.string(), response: z.string() },
    },
    async (args) => {
      const result = await ctx.backend.messageRespond(args)
      if (result.ok) resolveLocally(args.message_id)
      return asText(result)
    },
  )

  server.registerTool(
    "message_dismiss",
    {
      title: "Dismiss a message",
      description:
        "Explicitly decline to respond, with a reason (auditable). Clears gates the same as responding.",
      inputSchema: { message_id: z.string(), reason: z.string() },
    },
    async (args) => {
      const result = await ctx.backend.messageRespond({
        message_id: args.message_id,
        response: args.reason,
        dismiss: true,
      })
      if (result.ok) resolveLocally(args.message_id)
      return asText(result)
    },
  )
}
```

- [ ] **Step 3: decision_write requires_ack** — in `decisions.ts`, add `requires_ack: z.boolean().optional()` to `decision_write`'s inputSchema and, in its handler, after a successful non-conflict write:

```ts
      if (args.requires_ack && !("conflict" in result && result.conflict)) {
        const from = ctx.getSessionId()
        if (from) {
          await ctx.backend
            .messageSend({
              from_session: from,
              broadcast: true,
              kind: "decision",
              body: `Decision [${args.decision_key}]: ${args.content}`,
              requires_response: true,
              related_key: args.decision_key,
              repo_full_name: ctx.repoFullName,
            })
            .catch(() => {}) // ack fan-out is best-effort; the decision itself is written
        }
      }
```

(Adapt to the handler's actual result variable — read the existing `decision_write` handler first; it returns a `ConflictResult`.) Update the tool description: append "Set requires_ack to demand acknowledgment from all active sessions."

- [ ] **Step 4: Register** — in `index.ts` add `import { registerMessageTools } from "./tools/messages.js"` and call `registerMessageTools(server, toolContext)` next to the other registrations.

- [ ] **Step 5: Verify** — `pnpm -r typecheck && npx vitest run`. Expected: PASS. Tool count check: `node plugin/mcp/launch.mjs` isn't rebuilt yet — skip runtime check until Task 9.

- [ ] **Step 6: Commit** — `git commit -am "feat(tools): message_send/list/respond/dismiss, decision requires_ack"`

---

### Task 8: Shim wiring — prompt-sync fetch, cache persistence, collision_sent upkeep

**Files:**
- Modify: `packages/mcp/src/index.ts`

- [ ] **Step 1: Fetch** — in `fetchCoordinationData`, add to the `Promise.all`:

```ts
    sessionId
      ? backend.messagePending({ session_id: sessionId }).catch(() => ({ inbound: [], resolved: [] }))
      : Promise.resolve({ inbound: [], resolved: [] }),
```

and include `messages` in the returned object (update `SnapshotData` destructuring accordingly).

- [ ] **Step 2: Cache persistence** — in `persistCoordinationCaches`, derive and write the gate caches:

```ts
  const pendingInbound = data.messages.inbound.map((m) => ({
    message_id: m.id,
    from_label: m.from_agent_label ?? "session",
    from_user: m.from_user_name ?? "?",
    body: m.body.slice(0, 140),
    kind: m.kind,
    related_key: m.related_key,
    requires_response: m.requires_response,
    expires_at: m.expires_at,
  }))
  // Reconcile collision_sent with resolutions/expiry so the guard unlocks.
  const collisionSent = { ...(latest.collision_sent ?? {}) }
  for (const m of data.messages.resolved) {
    if (m.kind === "collision" && m.related_key && collisionSent[m.related_key]?.message_id === m.id) {
      collisionSent[m.related_key] = { ...collisionSent[m.related_key]!, status: m.status }
    }
  }
  for (const [path, entry] of Object.entries(collisionSent)) {
    if (new Date(entry.expires_at).getTime() <= Date.now() && entry.status === "pending") {
      delete collisionSent[path] // expired unanswered — guard already allows; drop the marker
    }
  }
```

write `pending_inbound: pendingInbound, collision_sent: collisionSent` in the `writeState` call.

- [ ] **Step 3: Snapshot section** — in `snapshot.ts`, add after the handoffs section (mirror its shape):

```ts
  const pendingMsgs = data.messages.inbound
  if (pendingMsgs.length > 0) {
    lines.push("", "### Pending messages for you")
    for (const m of pendingMsgs.slice(0, 5)) {
      const req = m.requires_response ? " [response required]" : ""
      lines.push(`- ${oneLine(m.body)} → message_respond(${m.id})${req}`)
    }
  }
```

(`renderSnapshot`'s input type is `SnapshotData`-shaped — pass the same object; update its signature to include `messages`, and update `snapshot.test.ts`'s `empty` fixture the same way as deltas'.)

- [ ] **Step 4: Verify** — `pnpm -r typecheck && npx vitest run`. Expected: PASS (snapshot tests updated).

- [ ] **Step 5: Commit** — `git commit -am "feat(shim): message delivery via prompt-sync, gate caches, snapshot inbox"`

---

### Task 9: Plugin surface — mjs mirrors, pre-tool-use v2, stop hook, manifests, bundle

**Files:**
- Modify: `plugin/scripts/lib/guard.mjs` (mirror Task 5's functions)
- Modify: `plugin/scripts/pre-tool-use.mjs`
- Create: `plugin/scripts/stop.mjs`
- Modify: `plugin/hooks/hooks.json`, `plugin/.claude-plugin/plugin.json`
- Rebuild: `plugin/mcp/index.mjs`

- [ ] **Step 1: Mirror guard.mjs** — port `parseGuardMode`, `collisionDecisionV2`, `ackGateDecision`, `stopGateDecision` from Task 5 verbatim (strip types). Keep the existing `collisionDecision` export (V2 calls it).

- [ ] **Step 2: pre-tool-use.mjs v2** — replace the decision section with:

```js
  const mode = parseGuardMode(
    process.env.CONTINUITY_COLLISION_GUARD ??
      process.env.CLAUDE_PLUGIN_OPTION_COLLISIONGUARD ??
      process.env.CLAUDE_PLUGIN_OPTION_COLLISION_GUARD,
  )
  if (mode === "off") return
  const state = readState(repo.cwdHash)
  const nowMs = Date.now()

  const collision = collisionDecisionV2({
    mode,
    entries: state?.others_activity,
    relPath: rel,
    warned: state?.collision_warned,
    collisionSent: state?.collision_sent,
    nowMs,
  })
  if (collision.action === "deny") {
    if (collision.warned && state) writeState(repo.cwdHash, { ...state, collision_warned: collision.warned })
    return deny(collision.reason)
  }

  const ack = ackGateDecision({ pendingInbound: state?.pending_inbound, messageWarned: state?.message_warned, nowMs })
  if (ack.warn) {
    if (state) writeState(repo.cwdHash, { ...state, message_warned: ack.warned })
    return deny(ack.reason)
  }
```

with `deny(reason)` emitting the same PreToolUse JSON as today (extract today's inline emit into that helper). Remove the old `guardDisabled()` (subsumed by `mode === "off"`).

- [ ] **Step 3: stop.mjs** — create:

```js
#!/usr/bin/env node
// Stop: block ending the turn while unexpired response-required messages are
// pending. At most one block per stop chain (stop_hook_active), and expired
// items never block — the timeout-override rule. Fail-open everywhere.
import { resolveRepoContext } from "./lib/gate.mjs"
import { stopGateDecision } from "./lib/guard.mjs"
import { readState } from "./lib/state.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const allowlist =
    process.env.CONTINUITY_REPO_ALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPOALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST
  const repo = resolveRepoContext(input.cwd || process.cwd(), allowlist)
  if (!repo) return
  const state = readState(repo.cwdHash)
  const decision = stopGateDecision({
    pendingInbound: state?.pending_inbound,
    stopHookActive: Boolean(input.stop_hook_active),
    nowMs: Date.now(),
  })
  if (decision.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }))
  }
}

main().catch(() => process.exit(0))
```

- [ ] **Step 4: hooks.json** — add (same env block as the PreToolUse entry):

```json
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/stop.mjs"],
            "timeout": 5,
            "env": {
              "CONTINUITY_REPO_ALLOWLIST": "${user_config.repoAllowlist}"
            }
          }
        ]
      }
    ],
```

- [ ] **Step 5: plugin.json** — change `collisionGuard` to a string enum and add the timeout:

```json
    "collisionGuard": {
      "type": "string",
      "title": "Collision guard mode",
      "description": "negotiate (default): contested edits are blocked until you message the other session and they respond, or the block times out. warn: single warning, retry proceeds. off: disabled. Legacy true/false values map to negotiate/off.",
      "default": "negotiate"
    },
    "messageTimeoutMinutes": {
      "type": "number",
      "title": "Message / block timeout (minutes)",
      "description": "How long messages and enforcement blocks live before expiring (the no-deadlock rule). Default 10.",
      "default": 10
    }
```

Pass the timeout into the MCP server env (check `plugin/.mcp.json` for how apiUrl etc. are passed and add `CONTINUITY_MESSAGE_TIMEOUT_MIN: "${user_config.messageTimeoutMinutes}"`); in `index.ts`, thread it: `expires_in_minutes: Number(process.env.CONTINUITY_MESSAGE_TIMEOUT_MIN) || undefined` in the `messageSend` calls made by tools (simplest: read it inside the message_send tool handler and decision fan-out, passing `expires_in_minutes`).

- [ ] **Step 6: Rebuild + full verify** — Run: `pnpm --filter @continuity/mcp build && pnpm -r typecheck && cd packages/mcp && npx vitest run`. Expected: bundle rebuilt, everything green.

- [ ] **Step 7: Commit** — `git commit -am "feat(plugin): negotiate guard, ack/stop gates, message config, bundle"`

---

### Task 10: E2E smoke, CHANGELOG, release alpha.3

**Files:**
- Modify: `CHANGELOG.md`, all six version manifests
- Scratch: two-session smoke (no repo files)

- [ ] **Step 1: E2E smoke** — scripted variant of the alpha.2 smoke (scratch dirs A/B with the same fake remote, isolated `CONTINUITY_DB_PATH` + `CLAUDE_PLUGIN_DATA`):
  1. A `--snapshot` (seeds), B `--checkin`.
  2. B session id → `sqlite3` INSERT a fresh `file_activity` row for `src/hot.ts` (as in the alpha.2 smoke).
  3. A: backdate `delta_synced_at`, `--prompt-sync` → expect the ⚠ same-repo delta.
  4. A: pipe `{"tool_name":"Edit","tool_input":{"file_path":"<A>/src/hot.ts"},"cwd":"<A>"}` into `pre-tool-use.mjs` → expect deny containing `message_send(` (negotiate default).
  5. Drive the MCP server over stdio (as in the validation checklist) or insert the collision message row directly: `INSERT INTO messages (...) VALUES ('m-e2e', <A_sid>, <B_sid>, 'test/e2e', 'collision', 'coordinating src/hot.ts', 1, 'src/hot.ts', 'pending', <now>, <now+10m>)` and add `collision_sent` to A's state file with that id → re-pipe the Edit → expect deny containing `expires in`.
  6. Mark the row responded (`UPDATE messages SET status='responded', response='go ahead', responded_at=<now> WHERE id='m-e2e'`), backdate A's `delta_synced_at`, `--prompt-sync` → expect "Response received: \"go ahead\"" AND the state file's `collision_sent['src/hot.ts'].status` to be `responded`; re-pipe the Edit → expect silence (allow).
  7. Stop gate: write a `pending_inbound` entry (requires_response, future expiry) into A's state, pipe `{"cwd":"<A>","stop_hook_active":false}` into `stop.mjs` → expect block JSON; with `"stop_hook_active":true` → expect silence; with expired entry → silence.
- [ ] **Step 2: CHANGELOG** — under `## [Unreleased]`, add an `### Added` block: direct messages (`message_send/list/respond/dismiss`), collision negotiation mode (new default; `warn`/`off` still available), `decision_write requires_ack`, Stop-hook reply gate, `messageTimeoutMinutes`; note team-mode routes are not yet served (follow-up). Then cut `## [0.1.0-alpha.3] - <date>`.
- [ ] **Step 3: Version bump** — `0.1.0-alpha.2` → `0.1.0-alpha.3` in: root `package.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `packages/{mcp,shared,server}/package.json`. Rebuild bundle (version is baked in): `pnpm --filter @continuity/mcp build`.
- [ ] **Step 4: Final verify** — `pnpm -r typecheck && cd packages/mcp && npx vitest run` all green; re-run the doctor: `node plugin/mcp/launch.mjs --doctor` reports v0.1.0-alpha.3.
- [ ] **Step 5: Commit + push** — `git commit -am "feat: agent messaging + enforced coordination (0.1.0-alpha.3)" && git push origin main`. Remind the user: `/plugin marketplace update continuity` → `/plugin update continuity@continuity` → `/reload-plugins`, and accept the new config prompts.

---

## Follow-up plan (not in this plan)

Team-flavor server: Worker routes `/messages/{send,respond,list,pending}` mirroring LocalBackend semantics, janitor sweep of old messages, contract-parity check extension, pg migration applied to Neon. Until then team mode's message tools return the Worker's 404 loudly.
