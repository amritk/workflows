// Tests for tools/pr-delta.cjs: `node --test tools/`.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, it } from "node:test"

const { spliceDelta, markers } = createRequire(import.meta.url)("./pr-delta.cjs")
const M = "demo-delta"
const { start: START, end: END } = markers(M)
const TABLE = `${START}\ntable v2\n${END}`

describe("pr-delta", () => {
  it("appends to a description without markers", () => {
    assert.equal(spliceDelta("My description.", TABLE, M), `My description.\n\n${TABLE}\n`)
  })

  it("handles a null or empty description", () => {
    assert.equal(spliceDelta(null, TABLE, M), `${TABLE}\n`)
    assert.equal(spliceDelta("", TABLE, M), `${TABLE}\n`)
  })

  it("replaces an existing block in place, keeping the text around it", () => {
    const body = `Intro.\n\n${START}\nold table\n${END}\n\nOutro.`
    assert.equal(spliceDelta(body, TABLE, M), `Intro.\n\n${TABLE}\n\nOutro.`)
  })

  it("is idempotent across runs", () => {
    const once = spliceDelta("Description.", TABLE, M)
    assert.equal(spliceDelta(once, TABLE, M), once)
  })

  it("repairs a dangling start marker instead of eating the description", () => {
    const body = `Keep me.\n${START}\nhalf a table\n\nKeep me too.`
    const next = spliceDelta(body, TABLE, M)
    assert.match(next, /Keep me\./)
    assert.match(next, /Keep me too\./)
    assert.equal(next.split(START).length, 2)
    assert.equal(next.split(END).length, 2)
  })

  it("treats an end marker before the start as stray", () => {
    const body = `${END}\nText.\n${START}\nold\n${END}`
    assert.equal(spliceDelta(body, TABLE, M), `${END}\nText.\n${TABLE}`)
  })

  it("wraps a block that does not carry its own markers", () => {
    assert.equal(spliceDelta("", "| a | b |", M), `${START}\n| a | b |\n${END}\n`)
  })

  it("leaves other markers alone", () => {
    const other = "<!-- other-delta:start -->\nx\n<!-- other-delta:end -->"
    assert.equal(spliceDelta(other, TABLE, M), `${other}\n\n${TABLE}\n`)
  })

  it("refuses a marker that could break out of the comment", () => {
    assert.throws(() => spliceDelta("", TABLE, "x --> <script>"), /marker must be/)
  })
})
