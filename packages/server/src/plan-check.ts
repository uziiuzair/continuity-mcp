import { getFileContent } from "./github.js"
import type { Bindings } from "./types.js"

// Pre-flight check: does a proposed task fit the repo's current development
// phase? Reads the phase doc from the target repo via the GitHub App, then asks
// Claude Haiku for a structured verdict. Falls back to "in_phase: true" (don't
// block work) when the docs or the ANTHROPIC_API_KEY are unavailable — the plan
// check is OPTIONAL and must never block when unconfigured.

const PHASE_DOC_PATH = "claude_docs/DEVELOPMENT_PHASES.md"
const MODEL = "claude-haiku-4-5"

export type PlanCheckResult = {
  in_phase: boolean
  current_phase: string | null
  rationale: string
  suggested_action: string | null
}

export async function planCheck(
  env: Bindings,
  taskDescription: string,
  repoFullName: string | undefined,
): Promise<PlanCheckResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      in_phase: true,
      current_phase: null,
      rationale: "plan check not configured",
      suggested_action: null,
    }
  }

  let phaseDoc: string | null = null
  if (repoFullName) {
    try {
      phaseDoc = await getFileContent(env, repoFullName, PHASE_DOC_PATH)
    } catch {
      phaseDoc = null
    }
  }
  if (!phaseDoc) {
    return {
      in_phase: true,
      current_phase: null,
      rationale: `No ${PHASE_DOC_PATH} found for ${repoFullName ?? "repo"}; not blocking.`,
      suggested_action: null,
    }
  }

  const system =
    "You gate engineering work against a project's current development phase. " +
    "Given the phase document and a proposed task, decide whether the task fits the CURRENT phase. " +
    'Respond ONLY with minified JSON: {"in_phase":boolean,"current_phase":string|null,"rationale":string,"suggested_action":string|null}. ' +
    "Be permissive for clearly in-scope or trivial work; flag only work that belongs to a later phase."

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [
        {
          role: "user",
          content: `PHASE DOCUMENT:\n${phaseDoc.slice(0, 12000)}\n\nPROPOSED TASK:\n${taskDescription}`,
        },
      ],
    }),
  })
  if (!res.ok) {
    return {
      in_phase: true,
      current_phase: null,
      rationale: `plan_check LLM error ${res.status}; not blocking.`,
      suggested_action: null,
    }
  }

  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  const text = json.content?.find((b) => b.type === "text")?.text ?? ""
  return parseResult(text)
}

function parseResult(text: string): PlanCheckResult {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : text) as Partial<PlanCheckResult>
    return {
      in_phase: parsed.in_phase !== false,
      current_phase: parsed.current_phase ?? null,
      rationale: parsed.rationale ?? "no rationale",
      suggested_action: parsed.suggested_action ?? null,
    }
  } catch {
    return {
      in_phase: true,
      current_phase: null,
      rationale: "plan_check response unparseable; not blocking.",
      suggested_action: null,
    }
  }
}
