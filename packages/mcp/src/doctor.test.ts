import { describe, expect, it } from "vitest"
import { type SettingsLike, duplicateInstallWarning, listContinuityInstalls } from "./doctor.js"

const twoInstalls = JSON.stringify({
  version: 2,
  plugins: {
    "continuity@arlo-internal": [{ scope: "user", installPath: "/x", version: "0.1.2" }],
    "continuity@continuity": [{ scope: "local", installPath: "/y", version: "0.1.0-alpha.1" }],
    "superpowers@claude-plugins-official": [{ scope: "user", installPath: "/z", version: "5.0.7" }],
  },
})

describe("listContinuityInstalls", () => {
  it("returns every installed plugin named 'continuity' with its scope", () => {
    const installs = listContinuityInstalls(twoInstalls)
    expect(installs).toHaveLength(2)
    expect(installs.map((i) => i.key).sort()).toEqual([
      "continuity@arlo-internal",
      "continuity@continuity",
    ])
    expect(installs.find((i) => i.key === "continuity@arlo-internal")?.scope).toBe("user")
  })

  it("ignores unrelated plugins and single installs work fine", () => {
    const one = JSON.stringify({
      version: 2,
      plugins: { "continuity@continuity": [{ scope: "user" }] },
    })
    expect(listContinuityInstalls(one)).toHaveLength(1)
  })

  it("fails open on malformed json", () => {
    expect(listContinuityInstalls("{nope")).toEqual([])
    expect(listContinuityInstalls("")).toEqual([])
  })
})

describe("duplicateInstallWarning", () => {
  it("warns when more than one continuity plugin is installed and enabled", () => {
    const warning = duplicateInstallWarning(twoInstalls)
    expect(warning).toContain("continuity@arlo-internal")
    expect(warning).toContain("continuity@continuity")
  })

  it("is null for zero or one install", () => {
    const one = JSON.stringify({
      version: 2,
      plugins: { "continuity@continuity": [{ scope: "user" }] },
    })
    expect(duplicateInstallWarning(one)).toBeNull()
    expect(duplicateInstallWarning("{}")).toBeNull()
  })

  it("does not count installs explicitly disabled in the settings chain", () => {
    const chain = [{ enabledPlugins: { "continuity@arlo-internal": false } }]
    expect(duplicateInstallWarning(twoInstalls, chain)).toBeNull()
  })

  it("lets later settings (project/local) override earlier (user)", () => {
    // user disables both, the project re-enables one → still only 1 enabled
    const chain: SettingsLike[] = [
      { enabledPlugins: { "continuity@arlo-internal": false, "continuity@continuity": false } },
      { enabledPlugins: { "continuity@continuity": true } },
    ]
    expect(duplicateInstallWarning(twoInstalls, chain)).toBeNull()
    // ...but re-enabling the second one too brings the warning back
    const bothOn: SettingsLike[] = [
      ...chain,
      { enabledPlugins: { "continuity@arlo-internal": true } },
    ]
    expect(duplicateInstallWarning(twoInstalls, bothOn)).not.toBeNull()
  })

  it("treats installs unmentioned in settings as enabled", () => {
    expect(duplicateInstallWarning(twoInstalls, [{ enabledPlugins: {} }, null])).not.toBeNull()
  })
})
