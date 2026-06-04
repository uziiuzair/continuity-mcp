import type { Bindings } from "./types.js"

// GitHub App client for the Worker. Tokens stay server-side: the shim and hooks
// never see a GitHub credential. We mint a short-lived app JWT (RS256), exchange
// it for an installation token, and cache that token in-isolate until it nears
// expiry.
//
// Every external call is gated on the three GITHUB_APP_* bindings being present.
// When any is missing we throw GitHubNotConfiguredError so the route layer can
// degrade to `{ error: "not_configured" }` instead of crashing — the Worker
// still deploys with only DATABASE_URL + API_KEY_HMAC_SECRET.

const GITHUB_API = "https://api.github.com"
const UA = "continuity-server"

export class GitHubNotConfiguredError extends Error {
  constructor() {
    super("github_app_not_configured")
    this.name = "GitHubNotConfiguredError"
  }
}

/** True only when all three GitHub App bindings are present. */
export function isGitHubConfigured(env: Bindings): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID)
}

// ---- token minting --------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null

function base64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
  const bin = atob(body)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

async function appJwt(env: Bindings): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GitHubNotConfiguredError()
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  // iat backdated 60s for clock skew; exp 9 min (max 10).
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID })),
  )
  const signingInput = `${header}.${payload}`

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(new Uint8Array(sig))}`
}

async function installationToken(env: Bindings): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token
  if (!env.GITHUB_APP_INSTALLATION_ID) throw new GitHubNotConfiguredError()

  const jwt = await appJwt(env)
  const res = await fetch(`${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
    },
  })
  if (!res.ok) throw new Error(`installation_token ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { token: string; expires_at: string }
  cachedToken = { token: json.token, expiresAt: new Date(json.expires_at).getTime() }
  return json.token
}

// ---- low-level transports -------------------------------------------------

async function rest<T>(env: Bindings, method: string, path: string, body?: unknown): Promise<T> {
  const token = await installationToken(env)
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${path} ${res.status}: ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

async function graphql<T>(env: Bindings, query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await installationToken(env)
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (json.errors) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`)
  return json.data as T
}

// De-Arlo-ified: the org/repo is never hardcoded. Every public function takes a
// `repo_full_name` ("owner/repo") parameter and splits it here.
function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/")
  if (!owner || !repo) throw new Error(`invalid repo_full_name: ${repoFullName}`)
  return { owner, repo }
}

// ---- public surface -------------------------------------------------------

export type GitHubIssue = {
  number: number
  title: string
  html_url: string
  state: string
  labels: string[]
  assignees: string[]
}

export async function listOpenIssues(env: Bindings, repoFullName: string): Promise<GitHubIssue[]> {
  const { owner, repo } = splitRepo(repoFullName)
  const raw = await rest<
    Array<{
      number: number
      title: string
      html_url: string
      state: string
      pull_request?: unknown
      labels: Array<{ name: string }>
      assignees: Array<{ login: string }>
    }>
  >(env, "GET", `/repos/${owner}/${repo}/issues?state=open&per_page=100`)
  // The issues endpoint also returns PRs; drop those.
  return raw
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      html_url: i.html_url,
      state: i.state,
      labels: i.labels.map((l) => l.name),
      assignees: i.assignees.map((a) => a.login),
    }))
}

export async function assignIssue(
  env: Bindings,
  repoFullName: string,
  issueNumber: number,
  login: string,
): Promise<void> {
  const { owner, repo } = splitRepo(repoFullName)
  await rest(env, "POST", `/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, { assignees: [login] })
}

export async function openPullRequest(
  env: Bindings,
  repoFullName: string,
  args: { branch: string; base?: string; title: string; body: string; issueNumber?: number },
): Promise<{ number: number; html_url: string }> {
  const { owner, repo } = splitRepo(repoFullName)
  const body = args.issueNumber != null ? `${args.body}\n\nCloses #${args.issueNumber}` : args.body
  return rest<{ number: number; html_url: string }>(env, "POST", `/repos/${owner}/${repo}/pulls`, {
    head: args.branch,
    base: args.base ?? "main",
    title: args.title,
    body,
  })
}

export async function getFileContent(env: Bindings, repoFullName: string, path: string): Promise<string | null> {
  const { owner, repo } = splitRepo(repoFullName)
  try {
    const json = await rest<{ content?: string; encoding?: string }>(
      env,
      "GET",
      `/repos/${owner}/${repo}/contents/${path}`,
    )
    if (!json.content) return null
    const bin = atob(json.content.replace(/\n/g, ""))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

// ---- Projects v2 ----------------------------------------------------------

export type ProjectSummary = { number: number; title: string; id: string }

export async function listProjects(env: Bindings, repoFullName: string): Promise<ProjectSummary[]> {
  const { owner, repo } = splitRepo(repoFullName)
  const data = await graphql<{
    repository: { projectsV2: { nodes: Array<{ number: number; title: string; id: string }> } }
  }>(
    env,
    `query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        projectsV2(first:20){ nodes { number title id } }
      }
    }`,
    { owner, repo },
  )
  return data.repository.projectsV2.nodes
}

// Set an issue's "Status" single-select field on the first project it belongs
// to (best-effort; resolves the project, the Status field, the matching option,
// and the issue's project item, then mutates). Returns false if any piece is
// missing rather than throwing, so a claim still succeeds when the board shape
// is unexpected.
export async function setIssueProjectStatus(
  env: Bindings,
  repoFullName: string,
  issueNumber: number,
  statusName: string,
): Promise<boolean> {
  const { owner, repo } = splitRepo(repoFullName)
  const data = await graphql<{
    repository: {
      issue: {
        projectItems: {
          nodes: Array<{
            id: string
            project: {
              id: string
              field: { id: string; options: Array<{ id: string; name: string }> } | null
            }
          }>
        }
      } | null
    }
  }>(
    env,
    `query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        issue(number:$num){
          projectItems(first:10){
            nodes{
              id
              project{
                id
                field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, num: issueNumber },
  )

  const item = data.repository?.issue?.projectItems.nodes.find((n) => n.project.field)
  if (!item || !item.project.field) return false
  const option = item.project.field.options.find((o) => o.name.toLowerCase() === statusName.toLowerCase())
  if (!option) return false

  await graphql(
    env,
    `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project, itemId:$item, fieldId:$field,
        value:{ singleSelectOptionId:$option }
      }){ projectV2Item { id } }
    }`,
    { project: item.project.id, item: item.id, field: item.project.field.id, option: option.id },
  )
  return true
}
