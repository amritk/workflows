// Checks a pull request title the way nish's release-notes generator reads a
// commit subject (amritk/nish, scripts/changelog-gen.mjs, `--check-subject`).
//
// The repositories that use this squash-merge, so a pull request's title
// becomes the subject of the one commit that lands on main, and that subject
// is what release notes and version bumps are made from (release-please here,
// nish's own generator there). The rule is nish's, ported exactly: the types
// are the ones with a release-notes section, and the subject is a heading, so
// it has no full stop. A change to it belongs in nish's generator first and
// here second, so the two never accept different titles.
//
// Usage: TITLE="feat(cli): add --check" node tools/pr-title.mjs
// The title comes from the environment, never argv or a `${{ }}` splice in a
// shell script: a pull request title is text anyone opening one can write.

import { pathToFileURL } from "node:url"

/** The types a title may name, each a section of the release notes. */
export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore"]

/** `type(scope)!: subject`, or undefined when the title is not conventional. */
export const parseTitle = (title) => {
  const m = title.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
  if (!m) return undefined
  return { type: m[1], scope: m[2], bang: Boolean(m[3]), subject: m[4].trim() }
}

/**
 * Checks one title. Returns `{ ok: true, summary }`, or `{ ok: false, message }`
 * where the message says what is wrong and how to fix it.
 */
export const checkTitle = (title) => {
  const parsed = parseTitle(title)
  if (!parsed) {
    return {
      ok: false,
      message: [
        `not a conventional commit subject:\n\n    ${title}\n`,
        `Expected \`type(scope): subject\`, where type is one of: ${TYPES.join(", ")}.`,
        "A `!` after the type or scope marks a breaking change.\n",
        "Examples:\n    feat(checker): accept non-generic type aliases",
        "    perf(codegen)!: hoist the array header out of element loops",
        "\nThe title becomes the heading in the release notes, so write it for a reader.",
      ].join("\n"),
    }
  }
  if (!TYPES.includes(parsed.type)) {
    return {
      ok: false,
      message: `unknown type \`${parsed.type}\` in:\n\n    ${title}\n\nUse one of: ${TYPES.join(", ")}.`,
    }
  }
  if (/[.]$/.test(parsed.subject)) {
    return { ok: false, message: `title ends with a full stop:\n\n    ${title}\n\nIt is a heading, not a sentence.` }
  }
  const scope = parsed.scope ? `(${parsed.scope})` : ""
  return { ok: true, summary: `ok: ${parsed.type}${scope}${parsed.bang ? "!" : ""} — ${parsed.subject}` }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkTitle(process.env.TITLE ?? "")
  if (result.ok) {
    console.log(result.summary)
  } else {
    // One annotation on the run summary, the full explanation in the log.
    console.log(`::error title=PR title::${result.message.split("\n")[0]}`)
    console.error(result.message)
    process.exit(1)
  }
}
