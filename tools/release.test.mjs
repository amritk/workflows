// Tests for tools/release.mjs: `node --test tools/`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  TARGETS,
  aur,
  formula,
  formulaClass,
  launcher,
  libraryPackage,
  mainPackage,
  parseSums,
  platformPackage,
  releasePleaseCheck,
  rows,
  tarballName,
} from "./release.mjs"

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"))

const digest = (char) => char.repeat(64)

/** A SHA256SUMS listing a tarball for each of `assets`, digests `a`, `b`, ... */
const sumsFile = (assets, { bin = "tool", version = "1.2.3" } = {}) => {
  const file = path.join(temp(), "SHA256SUMS")
  const lines = assets.map((asset, i) => `${digest("abcdef"[i])}  ${tarballName(bin, version, asset)}`)
  fs.writeFileSync(file, `${lines.join("\n")}\n${digest("9")}  tool-1.2.3.tgz\n`)
  return file
}

const channelFlags = (sums) => ({
  name: "tool",
  bin: "tool",
  version: "1.2.3",
  tag: "v1.2.3",
  repo: "owner/tool",
  summary: "Do one thing well",
  license: "MIT",
  sums,
})

describe("rows", () => {
  it("gives each target its runner and npm platform", () => {
    assert.deepEqual(rows('["aarch64-darwin"]'), [
      { asset: "aarch64-darwin", runner: "macos-15", host: "Darwin-arm64", os: "darwin", cpu: "arm64" },
    ])
  })

  it("drops a repeated target", () => {
    assert.equal(rows('["x86_64-linux", "x86_64-linux"]').length, 1)
  })

  it("refuses an unknown target, naming the known ones", () => {
    assert.throws(() => rows('["riscv64-linux"]'), /unknown target riscv64-linux; known: x86_64-linux/)
  })

  it("refuses an empty list and text that is not JSON", () => {
    assert.throws(() => rows("[]"), /non-empty/)
    assert.throws(() => rows("x86_64-linux"), /not JSON/)
  })
})

describe("parseSums", () => {
  it("reads text and binary markers and skips other lines", () => {
    const sums = parseSums(`${digest("a")}  one.tar.gz\n${digest("b")} *two.tgz\nnot a line\n`)
    assert.deepEqual([...sums], [
      ["one.tar.gz", digest("a")],
      ["two.tgz", digest("b")],
    ])
  })
})

describe("formulaClass", () => {
  it("camel-cases a formula name", () => {
    assert.equal(formulaClass("vector"), "Vector")
    assert.equal(formulaClass("my-tool"), "MyTool")
  })

  it("refuses a name Homebrew would not accept", () => {
    assert.throws(() => formulaClass("My Tool"), /not a Homebrew formula name/)
  })
})

describe("formula", () => {
  it("names each released platform's tarball and digest, and runs the binary by its path", () => {
    const rb = formula(channelFlags(sumsFile(["x86_64-linux", "aarch64-darwin"])))
    assert.match(rb, /^class Tool < Formula$/m)
    assert.match(rb, /desc "Do one thing well"/)
    assert.match(rb, /homepage "https:\/\/github.com\/owner\/tool"/)
    assert.match(
      rb,
      / {2}on_macos do\n {4}on_arm do\n {6}url "https:\/\/github.com\/owner\/tool\/releases\/download\/v1.2.3\/tool-1.2.3-aarch64-darwin.tar.gz"\n {6}sha256 "b{64}"\n {4}end\n {2}end/
    )
    assert.match(rb, / {2}on_linux do\n {4}on_intel do\n {6}url ".*tool-1.2.3-x86_64-linux.tar.gz"\n {6}sha256 "a{64}"/)
    assert.doesNotMatch(rb, /on_intel do\n {6}url ".*darwin/)
    assert.match(rb, /libexec.install buildpath.children/)
    assert.match(rb, /bin.write_exec_script libexec\/"bin\/tool"/)
  })

  it("is valid Ruby", (t) => {
    if (spawnSync("ruby", ["--version"]).status !== 0) {
      t.skip("no ruby on this machine")
      return
    }
    const file = path.join(temp(), "tool.rb")
    fs.writeFileSync(file, formula(channelFlags(sumsFile(Object.keys(TARGETS)))))
    const check = spawnSync("ruby", ["-c", file], { encoding: "utf8" })
    assert.equal(check.status, 0, check.stderr)
  })

  it("refuses sums that list no tarball for this version", () => {
    assert.throws(() => formula({ ...channelFlags(sumsFile(["x86_64-linux"])), version: "9.9.9" }), /lists no tool tarball for 9.9.9/)
  })
})

describe("aur", () => {
  it("writes a PKGBUILD for the Linux tarballs only, and a matching .SRCINFO", () => {
    const dir = temp()
    const { pkgbuild, srcinfo } = aur(dir, {
      ...channelFlags(sumsFile(["x86_64-linux", "aarch64-linux", "aarch64-darwin"])),
      package: "tool-bin",
      maintainer: "Someone <someone@example.com>",
    })
    assert.match(pkgbuild, /^# Maintainer: Someone <someone@example.com>$/m)
    assert.match(pkgbuild, /^arch=\('x86_64' 'aarch64'\)$/m)
    assert.match(pkgbuild, /^sha256sums_x86_64=\('a{64}'\)$/m)
    assert.match(pkgbuild, /^sha256sums_aarch64=\('b{64}'\)$/m)
    assert.doesNotMatch(pkgbuild, /darwin/)
    assert.match(srcinfo, /^pkgbase = tool-bin\n\tpkgdesc = Do one thing well\n\tpkgver = 1.2.3\n/)
    assert.match(srcinfo, /\n\tsource_aarch64 = tool-1.2.3-aarch64-linux.tar.gz::https:\/\/github.com\/owner\/tool\/releases\/download\/v1.2.3\/tool-1.2.3-aarch64-linux.tar.gz\n/)
    assert.match(srcinfo, /\npkgname = tool-bin\n$/)
    assert.equal(fs.readFileSync(path.join(dir, "PKGBUILD"), "utf8"), pkgbuild)
    assert.equal(fs.readFileSync(path.join(dir, ".SRCINFO"), "utf8"), srcinfo)
    const syntax = spawnSync("bash", ["-n", path.join(dir, "PKGBUILD")], { encoding: "utf8" })
    assert.equal(syntax.status, 0, syntax.stderr)
  })

  it("keeps a prerelease's hyphen out of pkgver but in the tarball's path", () => {
    const flags = { ...channelFlags(sumsFile(["x86_64-linux"], { version: "2.0.0-rc.1" })), version: "2.0.0-rc.1", package: "tool-bin" }
    const { pkgbuild } = aur(temp(), flags)
    assert.match(pkgbuild, /^pkgver=2.0.0_rc.1$/m)
    assert.match(pkgbuild, /"\$srcdir\/tool-2.0.0-rc.1-\$CARCH-linux\/\."/)
  })

  it("quotes a summary holding a single quote", () => {
    const { pkgbuild } = aur(temp(), { ...channelFlags(sumsFile(["x86_64-linux"])), summary: "It's fast", package: "tool-bin" })
    assert.match(pkgbuild, /^pkgdesc='It'\\''s fast'$/m)
  })

  it("refuses a release with no Linux tarball", () => {
    assert.throws(() => aur(temp(), { ...channelFlags(sumsFile(["aarch64-darwin"])), package: "tool-bin" }), /no Linux tool tarball/)
  })
})

describe("npm", () => {
  it("makes a platform package of a staged directory, dot-directories included", () => {
    const stage = temp()
    fs.mkdirSync(path.join(stage, "bin"))
    fs.mkdirSync(path.join(stage, ".data"))
    const manifest = platformPackage(stage, "aarch64-linux", "1.2.3", "@scope/tool", { license: "MIT" })
    assert.equal(manifest.name, "@scope/tool-aarch64-linux")
    assert.deepEqual([manifest.os, manifest.cpu], [["linux"], ["arm64"]])
    assert.deepEqual(manifest.files.sort(), [".data", "bin"])
    assert.equal(manifest.bin, undefined)
  })

  it("refuses a stage with no bin/", () => {
    assert.throws(() => platformPackage(temp(), "x86_64-linux", "1.2.3", "tool"), /has no bin\//)
  })

  it("writes a launcher node can parse", () => {
    const file = path.join(temp(), "tool.mjs")
    fs.writeFileSync(file, launcher("@scope/tool", "tool"))
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    assert.equal(check.status, 0, check.stderr)
  })

  it("packs the project with the launcher, the pins and no `private`", () => {
    const project = temp()
    fs.mkdirSync(path.join(project, "src"))
    fs.writeFileSync(path.join(project, "src", "main.ts"), "export const main = (): number => 0\n")
    fs.writeFileSync(path.join(project, "notes.txt"), "not shipped\n")
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "@scope/tool", version: "1.2.3", private: true, files: ["src"] })
    )
    const out = temp()
    const cwd = process.cwd()
    process.chdir(project)
    let tarball
    try {
      tarball = mainPackage(out, "tool", "1.2.3", ["x86_64-linux", "aarch64-darwin"])
    } finally {
      process.chdir(cwd)
    }
    const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort()
    assert.deepEqual(list, ["package/bin/tool.mjs", "package/package.json", "package/src/main.ts"])
    const manifest = JSON.parse(spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }).stdout)
    assert.equal(manifest.private, undefined)
    assert.deepEqual(manifest.bin, { tool: "bin/tool.mjs" })
    assert.deepEqual(manifest.optionalDependencies, {
      "@scope/tool-aarch64-darwin": "1.2.3",
      "@scope/tool-x86_64-linux": "1.2.3",
    })
  })

  it("refuses a package.json that is another version or already has a bin", () => {
    const project = temp()
    const cwd = process.cwd()
    process.chdir(project)
    try {
      fs.writeFileSync("package.json", JSON.stringify({ name: "tool", version: "1.0.0" }))
      assert.throws(() => mainPackage(temp(), "tool", "1.2.3", ["x86_64-linux"]), /version is 1.0.0, not 1.2.3/)
      fs.writeFileSync("package.json", JSON.stringify({ name: "tool", version: "1.2.3", bin: "x.js" }))
      assert.throws(() => mainPackage(temp(), "tool", "1.2.3", ["x86_64-linux"]), /declares bin/)
    } finally {
      process.chdir(cwd)
    }
  })

  it("packs a library as npm would, without `private`", () => {
    const project = temp()
    fs.mkdirSync(path.join(project, "src"))
    fs.writeFileSync(path.join(project, "src", "index.ts"), "export const one = (): number => 1\n")
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "lib", version: "2.0.0", private: true, files: ["src"] })
    )
    const cwd = process.cwd()
    process.chdir(project)
    let tarball
    try {
      tarball = libraryPackage(temp(), "2.0.0")
    } finally {
      process.chdir(cwd)
    }
    const manifest = JSON.parse(spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }).stdout)
    assert.equal(manifest.private, undefined)
    assert.equal(manifest.bin, undefined)
    const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }).stdout
    assert.match(list, /^package\/src\/index.ts$/m)
  })
})

describe("releasePleaseCheck", () => {
  const config = (settings = {}, top = {}) => ({
    ...top,
    packages: { ".": { "release-type": "node", "include-component-in-tag": false, ...settings } },
  })

  it("accepts one package tagged v<version>, and returns its path", () => {
    assert.equal(releasePleaseCheck(config(), { ".": "0.1.0" }, ".", "0.1.0"), ".")
  })

  it("reads settings from the top level too", () => {
    const top = { packages: { ".": {} }, "release-type": "simple", "include-component-in-tag": false }
    assert.equal(releasePleaseCheck(top, { ".": "1.0.0" }, "."), ".")
  })

  it("keys a subdirectory as release-please does, without ./ or a trailing slash", () => {
    const sub = { packages: { "test/hello": { "release-type": "node", "include-component-in-tag": false } } }
    assert.equal(releasePleaseCheck(sub, { "test/hello": "0.1.0" }, "./test/hello/", "0.1.0"), "test/hello")
  })

  it("refuses a component in the tag, which is release-please's default", () => {
    const { "include-component-in-tag": _, ...rest } = config().packages["."]
    assert.throws(() => releasePleaseCheck({ packages: { ".": rest } }, { ".": "0.1.0" }, "."), /include-component-in-tag/)
  })

  it("refuses a tag without its v", () => {
    assert.throws(() => releasePleaseCheck(config({ "include-v-in-tag": false }), { ".": "0.1.0" }, "."), /include-v-in-tag/)
  })

  it("refuses a draft release, which has no tag", () => {
    assert.throws(() => releasePleaseCheck(config({ draft: true }), { ".": "0.1.0" }, "."), /draft/)
  })

  it("refuses a config with no release-type", () => {
    assert.throws(
      () => releasePleaseCheck({ packages: { ".": { "include-component-in-tag": false } } }, { ".": "0.1.0" }, "."),
      /release-type/,
    )
  })

  it("refuses more than one package, or one at another path", () => {
    const two = config()
    two.packages["packages/b"] = { "release-type": "node" }
    assert.throws(() => releasePleaseCheck(two, { ".": "0.1.0" }, "."), /one package/)
    assert.throws(() => releasePleaseCheck(config(), { ".": "0.1.0" }, "test/hello"), /one package, "test\/hello"/)
  })

  it("refuses a manifest that is missing the package or disagrees with package.json", () => {
    assert.throws(() => releasePleaseCheck(config(), {}, "."), /manifest has no version/)
    assert.throws(() => releasePleaseCheck(config(), { ".": "0.1.0" }, ".", "0.2.0"), /0\.1\.0, but package.json's version is 0\.2\.0/)
  })
})

// The jobs of .github/workflows/release.yml, each with its `needs` and its
// `if` (a folded `>-` one joined to one line), read as text: the repository
// has no YAML parser, and these two keys are all the test needs.
const workflowJobs = () => {
  const file = path.join(import.meta.dirname, "../.github/workflows/release.yml")
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const jobs = {}
  let job = null
  for (let i = lines.indexOf("jobs:") + 1; i < lines.length; i++) {
    const name = /^ {2}([\w-]+):$/.exec(lines[i])
    if (name) {
      job = jobs[name[1]] = { needs: [], if: "" }
      continue
    }
    if (!job) continue
    const needs = /^ {4}needs: (.+)$/.exec(lines[i])
    if (needs) job.needs = needs[1].replace(/[[\]]/g, "").split(",").map((n) => n.trim())
    const cond = /^ {4}if: (.*)$/.exec(lines[i])
    if (cond && cond[1] !== ">-") job.if = cond[1]
    else if (cond) {
      const folded = []
      while (/^ {6}\S/.test(lines[i + 1] ?? "")) folded.push(lines[++i].trim())
      job.if = folded.join(" ")
    }
  }
  return jobs
}

describe("release.yml", () => {
  it("reads the jobs it checks", () => {
    const jobs = workflowJobs()
    for (const name of ["plan", "build", "release", "npm", "homebrew", "aur"]) assert.ok(jobs[name], name)
    assert.deepEqual(jobs.npm.needs, ["plan", "release"])
  })

  // An `if` with no status function is `success() && …`, and success() fails
  // when any job upstream was skipped. Library mode skips build, so a job after
  // release that leaned on success() would never run: v0.2.0 of a library
  // reached GitHub but not npm that way.
  it("gates every job after release on release's own result", () => {
    const after = Object.entries(workflowJobs()).filter(([, job]) => job.needs.includes("release"))
    assert.ok(after.length > 0)
    for (const [name, job] of after) {
      assert.match(job.if, /^!cancelled\(\) && needs\.release\.result == 'success' && /, name)
    }
  })
  // npm reads `npm publish npm/<name>.tgz` as GitHub's owner/repo shorthand and
  // tries to clone github.com/npm/<name>.tgz over ssh: vector's v0.2.1 failed
  // that way. A path npm reads as a file starts with ./, / or ~/.
  it("publishes each tarball by a path npm reads as a file", () => {
    const file = path.join(import.meta.dirname, "../.github/workflows/release.yml")
    const publishes = fs.readFileSync(file, "utf8").split("\n").filter((line) => /^\s*npm publish /.test(line))
    assert.ok(publishes.length > 0)
    for (const line of publishes) assert.match(line, /^\s*npm publish "(\.\/|\/|~\/)/, line.trim())
  })
})
