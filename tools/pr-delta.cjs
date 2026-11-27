'use strict'
// Splices a generated block (a benchmark or bundle-size delta table) into a
// pull request description between `<!-- <marker>:start -->` and
// `<!-- <marker>:end -->`, for actions/pr-delta. CommonJS so the action's
// github-script step can `require` it from the action's own checkout.

/** The two marker comments for a marker name, such as `niv-bench-delta`. */
const markers = (marker) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(marker)) {
    throw new Error(`pr-delta: marker must be lower-case letters, digits and dashes, got ${JSON.stringify(marker)}`)
  }
  return { start: `<!-- ${marker}:start -->`, end: `<!-- ${marker}:end -->` }
}

/**
 * Splices `block` into `body`: replaces an existing well-formed block in
 * place, otherwise appends. `block` must itself start with the start marker
 * and end with the end marker; a block without them is wrapped.
 *
 * Dangling markers are repaired rather than trusted: a start marker without an
 * end marker after it (or stray markers outside the block) would otherwise
 * poison the next run -- its indexOf would pair the stale start with the
 * freshly appended block's end and splice away every hand-written line in
 * between. Any marker text left after the well-formed block is handled is
 * stripped before appending.
 *
 * @param {string | null | undefined} body the current description
 * @param {string} block the generated markdown
 * @param {string} marker the marker name
 * @returns {string} the new description
 */
const spliceDelta = (body, block, marker) => {
  const { start, end } = markers(marker)
  let table = block.trim()
  if (!table.startsWith(start) || !table.endsWith(end)) {
    table = `${start}\n${table.split(start).join('').split(end).join('').trim()}\n${end}`
  }
  const current = body ?? ''
  const startIdx = current.indexOf(start)
  // Only an end marker after the start marker forms a block; an earlier one is stray.
  const endIdx = startIdx === -1 ? -1 : current.indexOf(end, startIdx + start.length)
  if (startIdx !== -1 && endIdx !== -1) {
    return current.slice(0, startIdx) + table + current.slice(endIdx + end.length)
  }
  // No well-formed block: strip stray or dangling markers, then append.
  const head = current.split(start).join('').split(end).join('').trimEnd()
  return head.length > 0 ? `${head}\n\n${table}\n` : `${table}\n`
}

module.exports = { spliceDelta, markers }
