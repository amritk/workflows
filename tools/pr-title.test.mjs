// Tests for the title rule actions/pr-title applies: the release-notes
// generator's own --check-subject. `node --test tools/`.
//
// These pin the cases where an inline grep pattern and nish's generator used
// to disagree, so the rule cannot drift back to either one's quirks unnoticed.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const GENERATOR = fileURLToPath(new URL("./changelog-gen.mjs", import.meta.url))
const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore"]
// The action runs with no checkout, so the check must need no repository.
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "pr-title-"))

const check = (title) => spawnSync(process.execPath, [GENERATOR, "--check-subject", title], { cwd: EMPTY, encoding: "utf8" })
const ok = (title) => check(title).status === 0

describe("pr-title", () => {
  it("accepts every release-notes type, with or without a scope", () => {
    for (const type of TYPES) {
      assert.equal(ok(`${type}: do the thing`), true, type)
      assert.equal(ok(`${type}(core): do the thing`), true, type)
    }
  })

  it("accepts a breaking change marked with !", () => {
    assert.equal(ok("perf(codegen)!: hoist the array header out of element loops"), true)
    assert.equal(ok("feat!: drop Node 18"), true)
  })

  it("parses scopes and spacing loosely", () => {
    for (const title of ["fix(Parser): handle tabs", "fix(parse tree): handle tabs", "fix:handle tabs", "fix:  handle tabs"])
      assert.equal(ok(title), true, title)
  })

  it("rejects types with no release-notes section", () => {
    for (const title of ["style: reformat the parser", "revert: undo the cache change", "feature: add x"]) {
      const r = check(title)
      assert.equal(r.status, 1, title)
      assert.match(r.stderr, /unknown type/)
    }
  })

  it("rejects a title that ends with a full stop", () => {
    const r = check("fix(cli): exit 2 on a missing file.")
    assert.equal(r.status, 1)
    assert.match(r.stderr, /full stop/)
  })

  it("rejects a title that is not conventional at all", () => {
    for (const title of ["Add an optional template compiler", "Fix: capital type", "fix handle tabs", "", " feat: leading space"]) {
      const r = check(title)
      assert.equal(r.status, 1, title)
      assert.match(r.stderr, /not a conventional commit subject/)
    }
  })

  it("keeps a title with shell metacharacters as text", () => {
    assert.equal(ok("fix: $(touch /tmp/pwned) `id`"), true)
  })
})
