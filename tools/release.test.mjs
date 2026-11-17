// Tests for tools/release.mjs: `node --test tools/`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  TARGETS,
  WASM_ASSET,
  aur,
  formula,
  formulaClass,
  launcher,
  libraryPackage,
  mainPackage,
  parseSums,
  platformPackage,
  postinstall,
  releasePleaseCheck,
  rows,
  tarballName,
  wasmName,
  wasmPackage,
  wasmRunner,
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
    assert.deepEqual([manifest.os, manifest.cpu, manifest.libc], [["linux"], ["arm64"], ["glibc"]])
    const mac = temp()
    fs.mkdirSync(path.join(mac, "bin"))
    assert.equal(platformPackage(mac, "aarch64-darwin", "1.2.3", "tool").libc, undefined)
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

  // node_modules as npm lays it out, under a directory whose name a shell
  // would expand if it were not quoted: the main package with its launcher and
  // install script, and this machine's platform package with `files` in it.
  const installed = (files) => {
    const asset = Object.keys(TARGETS).find((a) => `${TARGETS[a].os}-${TARGETS[a].cpu}` === `${process.platform}-${process.arch}`)
    const modules = path.join(temp(), "it's $HOME `x`", "node_modules")
    const main = path.join(modules, "tool", "bin")
    fs.mkdirSync(main, { recursive: true })
    fs.writeFileSync(path.join(main, "tool.mjs"), launcher("tool", "tool"), { mode: 0o755 })
    fs.writeFileSync(path.join(main, "tool-postinstall.mjs"), postinstall("tool", "tool"))
    const platform = asset === undefined ? null : path.join(modules, `tool-${asset}`)
    if (platform !== null && files !== null) {
      fs.mkdirSync(path.join(platform, "bin"), { recursive: true })
      fs.writeFileSync(path.join(platform, "package.json"), JSON.stringify({ name: `tool-${asset}` }))
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(platform, name)), { recursive: true })
        fs.writeFileSync(path.join(platform, name), text, { mode: 0o755 })
      }
    }
    const run = spawnSync(process.execPath, [path.join(main, "tool-postinstall.mjs")], { encoding: "utf8" })
    const command = path.join(main, "tool.mjs")
    return { asset, run, command, platform, text: fs.readFileSync(command, "utf8") }
  }
  // Reads a file staged beside it, as a binary that finds its data by its own path does.
  const binary = '#!/bin/sh\ncat "$(dirname "$0")/data.txt"\necho "$@"\nexit 4\n'

  it("points the command at the platform's binary, run where it lies", (t) => {
    const { asset, run, command, platform, text } = installed({ "bin/tool": binary, "bin/data.txt": "beside\n", LICENSE: "MIT\n" })
    if (asset === undefined) return t.skip("no target for this machine")
    assert.equal(run.status, 0, run.stderr)
    assert.match(text, /^#!\/bin\/sh\n/)
    const quoted = `'${path.join(platform, "bin", "tool").split("'").join("'\\''")}'`
    assert.ok(text.includes(`exec ${quoted} "$@"`), text)
    const ran = spawnSync(command, ["a b", "$HOME"], { encoding: "utf8" })
    assert.equal(ran.stdout, "beside\na b $HOME\n", ran.stderr)
    assert.equal(ran.status, 4)
    assert.deepEqual(fs.readdirSync(path.dirname(command)).sort(), ["tool-postinstall.mjs", "tool.mjs"])
  })

  it("says to run npm rebuild when the binary has moved", (t) => {
    const { asset, command, platform } = installed({ "bin/tool": binary })
    if (asset === undefined) return t.skip("no target for this machine")
    fs.rmSync(platform, { recursive: true })
    const ran = spawnSync(command, [], { encoding: "utf8" })
    assert.equal(ran.status, 2)
    assert.match(ran.stderr, /is not where it was installed; run 'npm rebuild tool'/)
  })

  it("keeps the launcher when no platform package is installed", () => {
    const { run, text } = installed(null)
    assert.equal(run.status, 0, run.stderr)
    assert.match(text, /^#!\/usr\/bin\/env node/)
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
    assert.deepEqual(list, [
      "package/bin/tool-postinstall.mjs",
      "package/bin/tool.mjs",
      "package/package.json",
      "package/src/main.ts",
    ])
    const manifest = JSON.parse(spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }).stdout)
    assert.equal(manifest.private, undefined)
    assert.deepEqual(manifest.bin, { tool: "bin/tool.mjs" })
    assert.equal(manifest.scripts.postinstall, "node bin/tool-postinstall.mjs")
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
      fs.writeFileSync("package.json", JSON.stringify({ name: "tool", version: "1.2.3", scripts: { postinstall: "x" } }))
      assert.throws(() => mainPackage(temp(), "tool", "1.2.3", ["x86_64-linux"]), /declares a postinstall script/)
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

/**
 * The smallest WASI command that says something: a module whose `_start`
 * calls `proc_exit(status)`, assembled by hand so the test needs no toolchain.
 */
const exitModule = (status) => {
  const name = (text) => [text.length, ...Buffer.from(text)]
  const section = (id, bytes) => [id, bytes.length, ...bytes]
  return Buffer.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    // (i32) -> () for proc_exit, () -> () for _start
    ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
    ...section(2, [1, ...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0x00, 0]),
    ...section(3, [1, 1]),
    ...section(5, [1, 0x00, 1]),
    ...section(7, [2, ...name("memory"), 0x02, 0, ...name("_start"), 0x00, 1]),
    // i32.const status; call proc_exit; end
    ...section(10, [1, 6, 0, 0x41, status, 0x10, 0, 0x0b]),
  ])
}

describe("wasm", () => {
  const module = (status = 7) => {
    const file = path.join(temp(), "tool.wasm")
    fs.writeFileSync(file, exitModule(status))
    return file
  }

  it("names the release's module", () => {
    assert.equal(wasmName("tool", "1.2.3"), "tool-1.2.3-wasm32-wasi.wasm")
  })

  it("makes a package with the module, its command and the staged files", () => {
    const stage = temp()
    fs.writeFileSync(path.join(stage, "LICENSE"), "MIT\n")
    const manifest = wasmPackage(stage, module(), "tool", "1.2.3", "@scope/tool", { license: "MIT" })
    assert.equal(manifest.name, "@scope/tool-wasm32-wasi")
    assert.equal(manifest.os, undefined)
    assert.equal(manifest.cpu, undefined)
    assert.deepEqual(manifest.bin, { tool: "bin/tool.mjs" })
    assert.equal(manifest.exports["./wasm"], "./bin/tool.wasm")
    assert.deepEqual(manifest.files.sort(), ["LICENSE", "bin"])
    assert.deepEqual(fs.readdirSync(path.join(stage, "bin")).sort(), ["tool.mjs", "tool.wasm"])
    assert.ok(fs.statSync(path.join(stage, "bin", "tool.mjs")).mode & 0o100)
  })

  it("refuses a file that is not WebAssembly, and a bin that is not a command name", () => {
    const text = path.join(temp(), "tool.wasm")
    fs.writeFileSync(text, "#!/bin/sh\necho tool\n")
    assert.throws(() => wasmPackage(temp(), text, "tool", "1.2.3", "tool"), /is not a WebAssembly module/)
    assert.throws(() => wasmPackage(temp(), module(), "../tool", "1.2.3", "tool"), /not a command name/)
  })

  it("writes a runner node can parse", () => {
    const file = path.join(temp(), "tool.mjs")
    fs.writeFileSync(file, wasmRunner("tool"))
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    assert.equal(check.status, 0, check.stderr)
  })

  it("runs the module under node, passing its exit status and printing no warning", () => {
    const stage = temp()
    wasmPackage(stage, module(7), "tool", "1.2.3", "tool")
    const run = spawnSync(process.execPath, [path.join(stage, "bin", "tool.mjs"), "--version"], { encoding: "utf8" })
    assert.equal(run.status, 7, run.stderr)
    assert.equal(run.stderr, "")
  })

  it("is what the launcher runs when no platform package is installed", () => {
    const modules = path.join(temp(), "node_modules")
    const wasm = path.join(modules, "tool-wasm32-wasi")
    fs.mkdirSync(wasm, { recursive: true })
    wasmPackage(wasm, module(5), "tool", "1.2.3", "tool")
    fs.mkdirSync(path.join(modules, "tool", "bin"), { recursive: true })
    const file = path.join(modules, "tool", "bin", "tool.mjs")
    fs.writeFileSync(file, launcher("tool", "tool", { wasm: true }))
    const run = spawnSync(process.execPath, [file], { encoding: "utf8" })
    assert.equal(run.status, 5, run.stderr)

    fs.rmSync(wasm, { recursive: true })
    const missing = spawnSync(process.execPath, [file], { encoding: "utf8" })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /install tool-wasm32-wasi, which runs tool on any platform node runs on/)
  })

  it("is named by the launcher only when the release has it", () => {
    assert.doesNotMatch(launcher("tool", "tool"), /wasm32-wasi/)
    assert.match(launcher("tool", "tool", { wasm: true }), /const WASM = "tool-wasm32-wasi"/)
  })

  it("turns on the main package's fallback without pinning it", () => {
    const project = temp()
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "tool", version: "1.2.3" }))
    const cwd = process.cwd()
    process.chdir(project)
    let tarball
    try {
      tarball = mainPackage(temp(), "tool", "1.2.3", ["x86_64-linux", WASM_ASSET])
      assert.throws(() => mainPackage(temp(), "tool", "1.2.3", [WASM_ASSET]), /at least one native target/)
    } finally {
      process.chdir(cwd)
    }
    const manifest = JSON.parse(spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }).stdout)
    assert.deepEqual(manifest.optionalDependencies, { "tool-x86_64-linux": "1.2.3" })
    const script = spawnSync("tar", ["-xzOf", tarball, "package/bin/tool.mjs"], { encoding: "utf8" }).stdout
    assert.match(script, /const WASM = "tool-wasm32-wasi"/)
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
    for (const name of ["plan", "build", "wasm", "release", "npm", "homebrew", "aur"]) assert.ok(jobs[name], name)
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
