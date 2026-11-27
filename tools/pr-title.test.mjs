// Tests for tools/pr-title.mjs: `node --test tools/`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { TYPES, checkTitle, parseTitle } from "./pr-title.mjs"

const SCRIPT = fileURLToPath(new URL("./pr-title.mjs", import.meta.url))

describe("pr-title", () => {
  it("accepts every release-notes type, with or without a scope", () => {
    for (const type of TYPES) {
      assert.equal(checkTitle(`${type}: do the thing`).ok, true, type)
      assert.equal(checkTitle(`${type}(core): do the thing`).ok, true, type)
    }
  })

  it("accepts a breaking change marked with !", () => {
    assert.equal(checkTitle("perf(codegen)!: hoist the array header out of element loops").ok, true)
    assert.equal(checkTitle("feat!: drop Node 18").ok, true)
    assert.equal(parseTitle("feat!: drop Node 18")?.bang, true)
  })

  it("parses loosely where nish's generator does", () => {
    // These are the cases an inline grep pattern used to reject and nish's
    // generator accepts; the rule follows the generator.
    for (const title of ["fix(Parser): handle tabs", "fix(parse tree): handle tabs", "fix:handle tabs", "fix:  handle tabs"])
      assert.equal(checkTitle(title).ok, true, title)
    assert.equal(parseTitle("fix:  handle tabs")?.subject, "handle tabs")
  })

  it("rejects types with no release-notes section", () => {
    for (const title of ["style: reformat the parser", "revert: undo the cache change", "feature: add x"]) {
      const result = checkTitle(title)
      assert.equal(result.ok, false, title)
      assert.match(result.message, /unknown type/)
    }
  })

  it("rejects a title that ends with a full stop", () => {
    const result = checkTitle("fix(cli): exit 2 on a missing file.")
    assert.equal(result.ok, false)
    assert.match(result.message, /full stop/)
  })

  it("rejects a title that is not conventional at all", () => {
    for (const title of ["Add an optional template compiler", "Fix: capital type", "fix handle tabs", ""]) {
      const result = checkTitle(title)
      assert.equal(result.ok, false, title)
      assert.match(result.message, /not a conventional commit subject/)
    }
  })

  it("reads the title from the environment and exits by the verdict", () => {
    const run = (title) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TITLE: title }, encoding: "utf8" })
    const good = run("feat(cli): add --check")
    assert.equal(good.status, 0)
    assert.match(good.stdout, /^ok: feat\(cli\) — add --check/)
    const bad = run("style: nope")
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /^::error title=PR title::unknown type `style`/)
    // Shell metacharacters stay text: the title is never evaluated.
    assert.equal(run("fix: $(touch /tmp/pwned) `id`").status, 0)
  })
})
