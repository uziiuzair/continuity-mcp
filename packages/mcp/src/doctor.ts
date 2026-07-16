// `--doctor` support. The pure parts live here (testable); the CLI gathers the
// environment and prints. Duplicate-install detection exists because a stale
// second continuity plugin (e.g. an old internal build installed user-wide)
// silently shadows this one's skills with its own — the failure mode is
// invisible without a check like this.

export type ContinuityInstall = { key: string; scope: string | null; version: string | null }

export function listContinuityInstalls(installedPluginsJson: string): ContinuityInstall[] {
  try {
    const parsed = JSON.parse(installedPluginsJson) as {
      plugins?: Record<string, { scope?: string; version?: string }[]>
    }
    const out: ContinuityInstall[] = []
    for (const [key, entries] of Object.entries(parsed?.plugins ?? {})) {
      if (key.split("@")[0] !== "continuity") continue
      const first = Array.isArray(entries) ? entries[0] : undefined
      out.push({ key, scope: first?.scope ?? null, version: first?.version ?? null })
    }
    return out
  } catch {
    return []
  }
}

// A settings object as read from ~/.claude/settings.json or a project's
// .claude/settings{,.local}.json. Only enabledPlugins matters here.
export type SettingsLike = { enabledPlugins?: Record<string, boolean> } | null | undefined

// Enable state resolves last-wins across the chain (user → project → local);
// an install never mentioned is enabled. A disabled duplicate is harmless, so
// it must not trigger the warning — the common case is exactly a stale install
// the user already switched off.
function isEnabled(key: string, settingsChain: SettingsLike[]): boolean {
  let on = true
  for (const s of settingsChain) {
    const v = s?.enabledPlugins?.[key]
    if (typeof v === "boolean") on = v
  }
  return on
}

export function duplicateInstallWarning(
  installedPluginsJson: string,
  settingsChain: SettingsLike[] = [],
): string | null {
  const installs = listContinuityInstalls(installedPluginsJson).filter((i) =>
    isEnabled(i.key, settingsChain),
  )
  if (installs.length < 2) return null
  const listed = installs
    .map((i) => `${i.key}${i.scope ? ` (${i.scope} scope)` : ""}${i.version ? ` v${i.version}` : ""}`)
    .join(", ")
  return (
    `⚠ Continuity: ${installs.length} continuity plugins are installed — ${listed}. ` +
    `Duplicate installs shadow each other's skills and confuse coordination; uninstall all but one ` +
    `(claude plugin uninstall, or the /plugin menu). Please surface this warning to the user.`
  )
}
