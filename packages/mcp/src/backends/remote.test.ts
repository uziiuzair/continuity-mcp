import type { Decision, TaskClaim } from "@continuity/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteBackend } from "./remote.js"

const SERVER = "https://continuity.example.com"
const API_KEY = "secret-key"

let backend: RemoteBackend
let fetchMock: ReturnType<typeof vi.fn>

// Build a minimal Response-like object the backend can consume.
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "d1",
    decision_key: "db",
    content: "Use Postgres",
    decision_type: "architecture",
    project_scope: null,
    author_user_id: null,
    author_agent_session_id: null,
    status: "active",
    supersedes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function claim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: "c1",
    repo_full_name: "o/r",
    issue_number: 7,
    claimed_by_user_id: null,
    claimed_by_agent_session_id: null,
    status: "claimed",
    pr_number: null,
    notes: null,
    claimed_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T06:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  backend = new RemoteBackend(SERVER, API_KEY)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("decisionWrite", () => {
  it("maps a 200 {decision} to { conflict:false, result }", async () => {
    const d = decision()
    fetchMock.mockResolvedValue(jsonResponse(200, { decision: d }))

    const res = await backend.decisionWrite({ decision_key: "db", content: "Use Postgres" })

    expect(res.conflict).toBe(false)
    if (!res.conflict) expect(res.result).toEqual(d)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${SERVER}/decisions/write`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it("maps a 409 {existing} to { conflict:true, existing }", async () => {
    const existing = decision({ content: "Use Postgres" })
    fetchMock.mockResolvedValue(jsonResponse(409, { existing }))

    const res = await backend.decisionWrite({ decision_key: "db", content: "Use MySQL" })

    expect(res.conflict).toBe(true)
    if (res.conflict) expect(res.existing).toEqual(existing)
  })
})

describe("taskClaim", () => {
  it("maps a 200 {claim} to { conflict:false, result }", async () => {
    const c = claim()
    fetchMock.mockResolvedValue(jsonResponse(200, { claim: c }))

    const res = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 7 })

    expect(res.conflict).toBe(false)
    if (!res.conflict) expect(res.result).toEqual(c)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${SERVER}/tasks/claim`)
    expect(init.method).toBe("POST")
  })

  it("maps a 409 {claim} to { conflict:true, existing }", async () => {
    const c = claim({ issue_number: 7 })
    fetchMock.mockResolvedValue(jsonResponse(409, { claim: c }))

    const res = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 7 })

    expect(res.conflict).toBe(true)
    if (res.conflict) expect(res.existing).toEqual(c)
  })
})

describe("GET requests", () => {
  it("builds the query string with Bearer auth and only defined params", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sessions: [] }))

    await backend.listActive({ max_age_seconds: 300, project_scope: undefined })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(`${SERVER}/agent/list_active`)
    expect(parsed.searchParams.get("max_age_seconds")).toBe("300")
    // undefined params are dropped from the query string
    expect(parsed.searchParams.has("project_scope")).toBe(false)
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    // GET requests carry no body
    expect(init.method ?? "GET").toBe("GET")
    expect(init.body).toBeUndefined()
  })
})

describe("error handling", () => {
  it("throws on a non-2xx non-409 response (POST path)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "boom" }))
    await expect(
      backend.decisionWrite({ decision_key: "db", content: "x" }),
    ).rejects.toThrow(/500/)
  })

  it("throws on a non-2xx non-409 response (GET path)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }))
    await expect(backend.listActive({})).rejects.toThrow(/401/)
  })
})

describe("worktree + repo_key wire fields", () => {
  const wt = { worktree_path: "/w/a", branch: "feat/a", is_worktree: true, repo_key: "k1" }

  it("checkin sends the new fields in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { session_id: "s1", reused: false }))
    await backend.checkin({ agent_label: "a", cwd_hash: "h", ...wt })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${SERVER}/agent/checkin`)
    expect(JSON.parse(init.body)).toMatchObject(wt)
  })

  it("heartbeat sends only the fields it was given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))
    await backend.heartbeat({ session_id: "s1", branch: "feat/b" })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${SERVER}/agent/heartbeat`)
    expect(JSON.parse(init.body)).toEqual({ session_id: "s1", branch: "feat/b" })
  })

  it("listActive sends same_repo_key (including empty) and maps the new session fields", async () => {
    const session = { session_id: "s1", agent_label: "a", user_name: "u", ...wt, status: "active" }
    fetchMock.mockResolvedValue(jsonResponse(200, { sessions: [session] }))
    const res = await backend.listActive({ same_repo_key: "k1" })
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get("same_repo_key")).toBe("k1")
    expect(res.sessions[0]).toMatchObject(wt)

    fetchMock.mockResolvedValue(jsonResponse(200, { sessions: [] }))
    await backend.listActive({ same_repo_key: "" })
    expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("same_repo_key")).toBe("")
  })

  it("messageSend forwards scope and repo_key", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message_ids: [], delivered: 0, expires_at: "x" }))
    await backend.messageSend({ from_session: "s1", broadcast: true, kind: "message", body: "hi", scope: "repo", repo_key: "k1" })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${SERVER}/messages/send`)
    expect(JSON.parse(init.body)).toMatchObject({ scope: "repo", repo_key: "k1" })
  })
})
