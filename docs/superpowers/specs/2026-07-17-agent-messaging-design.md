# Agent messaging & enforced coordination — design

Date: 2026-07-17
Status: approved (design), pending implementation plan

## Overview

Continuity today makes parallel Claude Code sessions *aware* of each other
(SessionStart snapshot, per-prompt deltas, a warn-once collision guard). This
feature adds *talk*: direct messages between sessions, and deterministic
enforcement that messages requiring a response actually get one. Enforcement is
built on hooks, not prompt text — a model cannot be forced to converse by
instructions alone, but it can be gated (edit denied, turn-end blocked) until it
responds, dismisses, or a timeout passes.

Four capabilities, one primitive:

1. **Direct messages** — session A sends to session B (or broadcasts); delivery
   is guaranteed via the existing `--prompt-sync` context injection.
2. **Collision negotiation** — editing a file another live session touched
   escalates from warn-once to a required message exchange (or timeout).
3. **Ack-required decisions** — `decision_write` can demand acknowledgment from
   all active sessions.
4. **Reply enforcement** — unanswered ack-required items gate the next edit
   (deny-once) and block turn-end (Stop hook), until resolved or expired.

**Deadlock rule (user-selected): timeout override.** Every block expires —
default 10 minutes, configurable. A silent counterpart can never stall work
indefinitely; proceeding after expiry is recorded, not hidden.

## Goals / non-goals

Goals:
- Single new storage primitive (`messages`) reused by all four capabilities.
- Both flavors (local SQLite, team Worker/Neon) through the existing
  `ContinuityBackend` seam.
- No network on any hook hot path — gates read only the session state file.
- Announce-once delivery through the existing `DeltaMemory` machinery.

Non-goals (YAGNI, explicitly cut):
- Message threads (a message carries at most one response).
- Synchronous wait (`send_and_wait`) — can be added later as one tool on top.
- Read receipts, typing indicators, cross-repo messaging.
- Waking an idle session — recipients see messages when their human next
  prompts; the timeout rule exists precisely because of this.

## Data model

New table `messages`, in both `schema.sqlite.ts` and `schema.pg.ts` (pg
migration `0002`), with the schema-parity check extended:

| column                  | type | notes                                            |
| ----------------------- | ---- | ------------------------------------------------ |
| id                      | text | pk (uuid)                                        |
| from_agent_session_id   | text | not null                                         |
| to_agent_session_id     | text | not null — always a single recipient             |
| repo_full_name          | text | nullable; scope stamp for filtering/audit        |
| kind                    | text | `message` \| `collision` \| `decision`           |
| body                    | text | not null                                         |
| requires_response       | int  | 0/1 (bool in pg)                                 |
| related_key             | text | nullable — file path (`collision`) or `decision_key` (`decision`) |
| status                  | text | `pending` \| `responded` \| `dismissed`          |
| response                | text | nullable — response or dismiss reason            |
| created_at              | text | ISO                                              |
| responded_at            | text | nullable ISO                                     |
| expires_at              | text | ISO = created_at + timeout                       |

Indexes: `(to_agent_session_id, status)`, `(from_agent_session_id, status)`,
`(expires_at)`.

**Broadcast = fan-out at send.** Sending with `broadcast: true` creates one row
per currently-active session (active within 5 minutes, sender excluded). This
keeps per-recipient status trivial and gates row-countable. Sessions that check
in later do not receive old broadcasts (the snapshot already carries decisions).

**Expiry is lazy, like sessions.** `status` stays `pending` past `expires_at`;
every reader treats `expires_at <= now` as expired (never blocks, rendered as
expired). The team janitor may additionally sweep, but correctness never
depends on it. Timestamps are compared in the backend clock domain, matching
the delta high-water-mark convention.

## Backend seam

`ContinuityBackend` gains:

```ts
messageSend(args: { from_session: string; to_session?: string; broadcast?: boolean;
  kind: MessageKind; body: string; requires_response?: boolean;
  related_key?: string; repo_full_name?: string; expires_in_minutes?: number })
  : Promise<{ message_ids: string[]; delivered: number; expires_at: string }>
messageRespond(args: { message_id: string; response: string; dismiss?: boolean })
  : Promise<{ ok: boolean }>
messageList(args: { session_id: string; direction?: "inbound" | "outbound";
  status?: MessageStatus; limit?: number }): Promise<{ messages: Message[] }>
// Everything prompt-sync needs in one call: pending inbound for me + freshly
// resolved outbound of mine (responses/dismissals I haven't seen).
messagePending(args: { session_id: string }): Promise<{ inbound: Message[]; resolved: Message[] }>
```

Local flavor: hand-written SQL in `LocalBackend` (existing style). Team flavor:
Worker routes `POST /messages`, `POST /messages/:id/respond`, `GET /messages`,
`GET /messages/pending` mirroring the local semantics; contract-parity check
extended.

## Tools (MCP, both flavors)

- `message_send({ to_session?, broadcast?, body, requires_response?, about_file? })` —
  exactly one of `to_session`/`broadcast`. `about_file` (repo-relative path)
  marks the message as collision coordination: the shim sets
  `kind: "collision"`, `related_key: about_file`, forces
  `requires_response: true`, and stamps `collision_sent[about_file]` in the
  state file. Returns delivered count + ids.
- `message_list({ direction?, status? })` — inbox/outbox for this session.
- `message_respond({ message_id, response })` — answers; the response reaches
  the sender on the sender's next prompt-sync.
- `message_dismiss({ message_id, reason })` — explicit, auditable refusal;
  resolves all gates the same as responding.
- `decision_write` gains `requires_ack?: boolean` — after writing the decision,
  fans out `kind: "decision"` messages (`requires_response: true`,
  `related_key: decision_key`) to active sessions. `message_respond` on that
  message *is* the ack; no separate ack tool.

**Tool handlers update the local state file synchronously** (they run inside
the shim, which owns the state file): `message_send(kind: "collision")` stamps
`collision_sent[path]`; `message_respond`/`message_dismiss` remove the item
from `pending_inbound`. This keeps gates correct within a turn without any
network on the hook side.

## Delivery — prompt-sync and snapshot

`fetchCoordinationData` adds `messagePending`. New injected lines (same
announce-once rules, ids recorded in `DeltaMemory.known_messages`):

- `- Message from alpha (Ann): "…" → respond via message_respond(<id>) [response required, expires in 8m]`
- `- alpha (Ann) responded: "…" (re: your collision on src/db.ts)`
- `- alpha dismissed your message: "…"`
- `- Decision [orm] requires your ack → message_respond(<id>)`
(Expiry of your own collision message is not separately announced — the guard's
deny text already states the block lifts automatically on expiry, and the edit
simply proceeds once it has.)

The SessionStart snapshot gains a `### Pending messages for you` section
(mirrors handoffs). Prompt-sync also refreshes the state-file caches that gates
read (below).

## State file additions

```ts
// SessionState gains:
pending_inbound?: PendingInboundEntry[]  // written by prompt-sync/snapshot,
                                         // pruned synchronously by respond/dismiss handlers
collision_sent?: Record<string, { message_id: string; expires_at: string }>
                                         // stamped by message_send(kind:"collision"),
                                         // pending stamps are pruned at expiry; responded/
                                         // dismissed stamps persist for the session (negotiated
                                         // consent holds — the guard's allow needs the stamp)
message_warned?: string[]                // message ids already used in a deny-once
                                         // (same pattern as collision_warned)
// DeltaMemory gains:
known_inbound: string[]                  // announce-once for inbound messages
known_resolved: string[]                 // announce-once for resolutions of my outbound
```

## Gates

All gates: pure state-file reads plus a local clock comparison against
`expires_at` — expiry unlocks mid-turn without waiting for a prompt. Pure
decision functions live in `guard.ts` with mirrors in `plugin/scripts/lib/`
(existing convention).

### Collision negotiation (guard v2)

Config `collisionGuard: "negotiate" | "warn" | "off"` (replaces the boolean;
**default `negotiate`**; `"warn"` = today's warn-once; existing boolean values
map: `true → negotiate`, `false → off`).

Decision table for an edit on path P touched by another live session (within
the 30m activity window):

| state                                            | decision |
| ------------------------------------------------ | -------- |
| no `collision_sent[P]`                           | deny: "session X is in this file — coordinate via `message_send({to_session: "<X>", about_file: "<P>", body: …})`, or pick other work; the block expires with the activity window." |
| `collision_sent[P]` pending, unexpired           | deny: "awaiting response from X, expires in Nm — work elsewhere meanwhile" |
| `collision_sent[P]` responded                    | allow (prompt-sync injected the response) |
| `collision_sent[P]` dismissed                    | allow — dismissal resolves the sender's gate exactly like a response; the dismissal reason reaches the sender via prompt-sync, so proceeding is informed, and a deny here would invite message ping-pong and violate the never-outlive-the-window rule |
| `collision_sent[P]` expired (or malformed `expires_at`) | allow; fail open |
| mode `warn`                                      | today's warn-once behavior |
| mode `off`                                       | allow |

The collision message is created by the model calling `message_send` with
`about_file` — the deny reason spells out the exact call, and the hook itself
never touches the network.

### Ack gate (PreToolUse)

Unexpired `pending_inbound` items with `requires_response: true` whose id set
isn't covered by `message_warned` → one deny listing the items ("respond or
dismiss, or they expire at …"); ids added to `message_warned`; retry passes.
Deny-once, not repeat-deny: the Stop gate provides the backstop, and
repeat-denying edits for unrelated work would be hostile.

### Stop gate (new hook)

`Stop` hook (sync, timeout 5s, new `plugin/scripts/stop.mjs`): if unexpired
`requires_response` items remain in `pending_inbound` → emit
`{ "decision": "block", "reason": "<items>; respond via message_respond(id) or dismiss via message_dismiss(id, reason)" }`.
The model resolves them (handlers prune the cache synchronously) and ends the
turn. Loop safety: when the hook input has `stop_hook_active: true`, always
allow — at most one block per stop chain, so an unresolvable state can never
loop. Expired items never block.

## Configuration

`plugin.json` userConfig:
- `collisionGuard`: string enum `negotiate | warn | off`, default `negotiate`.
- `messageTimeoutMinutes`: number, default `10`. Flows to the shim as
  `CONTINUITY_MESSAGE_TIMEOUT_MIN` via hook/MCP env; `expires_at` computed
  backend-side at send.

`hooks.json`: add the `Stop` entry (sync); extend the PreToolUse env with the
new vars.

## Testing

TDD (pure modules first):
- `deltas.test.ts`: message/response/expiry rendering, announce-once via
  `known_messages`, decision-ack lines.
- `guard.test.ts`: collision negotiation decision table (all six rows), ack
  gate deny-once, stop gate (pending/expired/`stop_hook_active`).
- `local.test.ts`: messages CRUD, broadcast fan-out to active-only sessions,
  respond/dismiss transitions, lazy expiry, `messagePending` shape.
- Schema/contract parity checks extended for the new table and routes.

E2E (two-session smoke, as shipped for alpha.2): B sends ack-required message →
A's prompt-sync injects it → A's edit denied once → A responds → B's next sync
sees the response. Collision path: contested edit → deny → `message_send` →
deny("awaiting") → respond from B → allow. Stop path verified live (block, then
resolve, then clean stop). Timeout path: backdate `expires_at`, confirm every
gate unlocks.

## Rollout

Ships as `0.1.0-alpha.3`: schema addition is additive (sqlite DDL self-creates
on open; pg migration `0002`), tools register in both flavors, new hook entry
requires plugin update + reload. CHANGELOG under Unreleased until the version
bump (release rule: `/plugin update` keys off the manifest version).
