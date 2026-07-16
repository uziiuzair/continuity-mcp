// Compile-time only: proves the Postgres and SQLite inferred row types are both
// structurally assignable to the shared mappers. If a column drifts between the
// two schemas in a way the mappers can't bridge, `tsc` fails here. Never called.

import {
  toActiveSession,
  toAuditEvent,
  toDecision,
  toHandoff,
  toMessage,
  toRecentFileActivity,
  toSessionDetail,
  toTaskClaim,
} from "./mappers.js"
import * as pg from "./schema.pg.js"
import * as sq from "./schema.sqlite.js"

export function _schemaParityChecks(): void {
  toSessionDetail({} as pg.AgentSessionRow)
  toSessionDetail({} as sq.AgentSessionRow)

  toActiveSession({} as pg.AgentSessionRow, "")
  toActiveSession({} as sq.AgentSessionRow, "")

  toRecentFileActivity({} as pg.FileActivityRow, { agentLabel: "", userName: "" })
  toRecentFileActivity({} as sq.FileActivityRow, { agentLabel: "", userName: "" })

  toDecision({} as pg.DecisionRow)
  toDecision({} as sq.DecisionRow)

  toTaskClaim({} as pg.TaskClaimRow)
  toTaskClaim({} as sq.TaskClaimRow)

  toHandoff({} as pg.HandoffRow)
  toHandoff({} as sq.HandoffRow)

  toAuditEvent({} as pg.AuditEventRow)
  toAuditEvent({} as sq.AuditEventRow)

  toMessage({} as pg.MessageRow)
  toMessage({} as sq.MessageRow)
}
