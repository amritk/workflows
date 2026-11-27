// The verdict of a CI gate job: whether every job it needs succeeded, from
// nish's ci.yml (scripts/ci-scope.mjs --gate). actions/ci-gate runs it.
//
// A gate is one job that needs every other job and runs `if: always()`, so a
// repository requires one check, `ci-gate`, instead of a list that goes stale
// whenever a job is added, renamed or split into a matrix. A skipped job fails
// the gate unless it is named as allowed to skip: a job skipped by accident
// (a broken `if:`, a failed dependency) is exactly what a gate must not let
// through as green.
//
//   NEEDS='${{ toJSON(needs) }}' ALLOW_SKIPPED='["docs"]' node tools/ci-gate.mjs

import fs from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The jobs that did not pass, each as `job: result`; empty when the gate
 * passes. No results at all fails, since a gate that needs nothing is wired
 * wrong.
 *
 * @param {Record<string, { result?: string }>} needs the `needs` context
 * @param {string[]} allowSkipped jobs that may be skipped
 * @returns {string[]} what failed
 */
export const gate = (needs, allowSkipped) => {
  if (!needs || typeof needs !== "object" || Object.keys(needs).length === 0) return ["no job results"]
  const bad = []
  for (const [job, value] of Object.entries(needs)) {
    const result = value?.result
    if (result === "success") continue
    if (result === "skipped" && allowSkipped.includes(job)) continue
    bad.push(`${job}: ${result ?? "no result"}`)
  }
  return bad
}

// Compared as real paths: Node resolves this module's URL through symlinks
// and argv[1] only through `path.resolve`, so on a runner whose work or
// actions directory is a symlink a plain URL comparison would skip the verdict
// and exit 0 -- a gate that passes without looking.
const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? "")
  } catch {
    return false
  }
})()

if (isMain) {
  let bad
  try {
    const allowSkipped = JSON.parse(process.env.ALLOW_SKIPPED || "[]")
    if (!Array.isArray(allowSkipped)) throw new Error("ALLOW_SKIPPED must be a JSON array of job names")
    bad = gate(JSON.parse(process.env.NEEDS ?? ""), allowSkipped)
  } catch (error) {
    bad = [`could not read the job results: ${error.message}`]
  }
  if (bad.length === 0) {
    console.log("every needed job succeeded")
  } else {
    for (const line of bad) console.log(`::error title=ci-gate::${line}`)
    process.exitCode = 1
  }
}
