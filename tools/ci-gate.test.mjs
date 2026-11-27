// Tests for tools/ci-gate.mjs: `node --test tools/`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { gate } from "./ci-gate.mjs"

const SCRIPT = fileURLToPath(new URL("./ci-gate.mjs", import.meta.url))

describe("ci-gate", () => {
  it("passes when every job succeeded", () => {
    assert.deepEqual(gate({ lint: { result: "success" }, test: { result: "success" } }, []), [])
  })

  it("fails on a failed, cancelled or skipped job", () => {
    const needs = { a: { result: "failure" }, b: { result: "cancelled" }, c: { result: "skipped" }, d: { result: "success" } }
    assert.deepEqual(gate(needs, []), ["a: failure", "b: cancelled", "c: skipped"])
  })

  it("lets a job named as allowed skip, and only skip", () => {
    assert.deepEqual(gate({ docs: { result: "skipped" } }, ["docs"]), [])
    assert.deepEqual(gate({ docs: { result: "failure" } }, ["docs"]), ["docs: failure"])
  })

  it("fails when it needs nothing, since that is a wiring mistake", () => {
    assert.deepEqual(gate({}, []), ["no job results"])
    assert.deepEqual(gate(null, []), ["no job results"])
  })

  it("reads the environment and exits by the verdict", () => {
    const run = (env) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, encoding: "utf8" })
    assert.equal(run({ NEEDS: '{"a":{"result":"success"}}', ALLOW_SKIPPED: "" }).status, 0)
    const bad = run({ NEEDS: '{"a":{"result":"failure"}}' })
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /::error title=ci-gate::a: failure/)
    assert.equal(run({ NEEDS: "not json" }).status, 1)
    assert.equal(run({ NEEDS: '{"a":{"result":"skipped"}}', ALLOW_SKIPPED: '"a"' }).status, 1)
  })
})

describe("ci-gate entry point", () => {
  it("runs the verdict when invoked through a symlinked path", async () => {
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join, dirname } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-"))
    try {
      const link = join(dir, "tools")
      symlinkSync(dirname(SCRIPT), link)
      const r = spawnSync(process.execPath, [join(link, "ci-gate.mjs")], {
        env: { ...process.env, NEEDS: '{"a":{"result":"failure"}}' },
        encoding: "utf8",
      })
      assert.equal(r.status, 1)
      assert.match(r.stdout, /a: failure/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
