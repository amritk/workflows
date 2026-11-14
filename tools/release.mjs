#!/usr/bin/env node
/**
 * The packaging half of `.github/workflows/release.yml`. Plain Node with no
 * dependencies, so every job can run it straight from a checkout of this
 * repository. Each command reads its inputs from flags and writes to stdout
 * or to the paths it is given.
 *
 *   release.mjs rows <targets-json>      the build matrix
 *   release.mjs platform <stage> <asset> <version> <npm-name>
 *   release.mjs main <out> <bin> <version> <asset>...
 *   release.mjs library <out> <version>
 *   release.mjs formula --name --bin --version --tag --repo --summary --homepage --license --sums
 *   release.mjs aur <dir> --package --bin --version --tag --repo --summary --homepage --license --sums [--maintainer]
 *   release.mjs release-please <config> <manifest> <path> [<version>]
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Every platform the workflow builds. `asset` is the target triple with the
 * vendor and ABI dropped (`x86_64-linux`), the spelling nish's own release
 * assets use; `host` is `uname -s`-`uname -m` on the runner, checked before a
 * binary is labelled with the asset. `brew` and `aur` are what Homebrew and
 * pacman call the same machine.
 */
export const TARGETS = {
  "x86_64-linux": {
    runner: "ubuntu-24.04",
    host: "Linux-x86_64",
    os: "linux",
    cpu: "x64",
    brew: ["linux", "intel"],
    aur: "x86_64",
  },
  "aarch64-linux": {
    runner: "ubuntu-24.04-arm",
    host: "Linux-aarch64",
    os: "linux",
    cpu: "arm64",
    brew: ["linux", "arm"],
    aur: "aarch64",
  },
  "aarch64-darwin": {
    runner: "macos-15",
    host: "Darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    brew: ["macos", "arm"],
    aur: null,
  },
  "x86_64-darwin": {
    runner: "macos-15-intel",
    host: "Darwin-x86_64",
    os: "darwin",
    cpu: "x64",
    brew: ["macos", "intel"],
    aur: null,
  },
}

/**
 * The Ed25519 host key of aur.archlinux.org, as Arch Linux published it
 * (https://archlinux.org/news/aur-migration-new-ssh-hostkeys/). The AUR job
 * refuses a server that presents any other.
 */
export const AUR_HOST_KEY = "SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4"

class UsageError extends Error {}

const fail = (message) => {
  throw new UsageError(message)
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    fail(`${command} ${args.join(" ")} exited ${result.status}`)
  }
  return result.stdout
}

/** `--key value` flags into an object; every flag takes a value. */
export const parseFlags = (args) => {
  const flags = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (i + 1 >= args.length) {
        fail(`${args[i]} needs a value`)
      }
      flags[args[i].slice(2)] = args[++i]
    } else {
      rest.push(args[i])
    }
  }
  return { flags, rest }
}

const need = (flags, ...names) => {
  for (const name of names) {
    if (flags[name] === undefined || flags[name] === "") {
      fail(`--${name} is required`)
    }
  }
}

/**
 * The release's SHA256SUMS, as a map from file name to digest. Accepts
 * `sha256sum`'s text and binary markers.
 */
export const parseSums = (text) => {
  const sums = new Map()
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())
    if (match !== null) {
      sums.set(match[2], match[1])
    }
  }
  return sums
}

/** The tarball a release attaches for one asset; every channel names it. */
export const tarballName = (bin, version, asset) => `${bin}-${version}-${asset}.tar.gz`

const releaseUrl = (repo, tag, file) => `https://github.com/${repo}/releases/download/${tag}/${file}`

/** The assets SHA256SUMS has a tarball for, in TARGETS order. */
const releasedAssets = (sums, bin, version) =>
  Object.keys(TARGETS).filter((asset) => sums.has(tarballName(bin, version, asset)))

// --- rows ----------------------------------------------------------------------

export const rows = (targetsJson) => {
  let assets
  try {
    assets = JSON.parse(targetsJson)
  } catch {
    fail(`targets is not JSON: ${targetsJson}`)
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    fail("targets must be a non-empty JSON array of assets")
  }
  const unknown = assets.filter((a) => !(a in TARGETS))
  if (unknown.length > 0) {
    fail(`unknown target ${unknown.join(", ")}; known: ${Object.keys(TARGETS).join(", ")}`)
  }
  return [...new Set(assets)].map((asset) => {
    const { runner, host, os: platform, cpu } = TARGETS[asset]
    return { asset, runner, host, os: platform, cpu }
  })
}

// --- npm -----------------------------------------------------------------------

/**
 * Turn a staged release directory into the npm package holding one
 * platform's binary: `<npm-name>-<asset>`, with `os` and `cpu` so npm
 * installs it only on that machine. It declares no `bin`; the command is the
 * main package's launcher.
 */
export const platformPackage = (stage, asset, version, npmName, meta = {}) => {
  const target = TARGETS[asset] ?? fail(`unknown target ${asset}`)
  const entries = fs.readdirSync(stage).filter((name) => name !== "package.json")
  if (!entries.includes("bin")) {
    fail(`${stage} has no bin/; stage the binary before packaging it`)
  }
  const manifest = {
    name: `${npmName}-${asset}`,
    version,
    description: `The ${npmName} binary for ${target.os} on ${target.cpu}`,
    license: meta.license,
    os: [target.os],
    cpu: [target.cpu],
    exports: { "./package.json": "./package.json" },
    // By name, so a dot-directory a program reads beside its binary is
    // packed like everything else.
    files: entries,
    repository: meta.repository,
    homepage: meta.homepage,
  }
  writeJson(path.join(stage, "package.json"), manifest)
  return manifest
}

/**
 * The launcher npm links as the command. It finds the platform package by
 * node's module resolution, so it works wherever npm put it, and runs the
 * binary by its absolute path, so a binary can find files beside itself from
 * `argv[0]` even where there is no `/proc/self/exe`.
 */
export const launcher = (npmName, bin) => {
  const byPlatform = Object.fromEntries(Object.entries(TARGETS).map(([asset, t]) => [`${t.os}-${t.cpu}`, asset]))
  return `#!/usr/bin/env node
// Generated by amritk/workflows: runs the prebuilt ${bin} for this platform.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const ASSETS = ${JSON.stringify(byPlatform)}
const refuse = (why) => {
  process.stderr.write(\`${bin}: \${why}\\n\`)
  process.exit(2)
}
const asset = ASSETS[\`\${process.platform}-\${process.arch}\`]
if (asset === undefined) {
  refuse(\`no prebuilt binary for \${process.platform}/\${process.arch}; one is published for \${Object.values(ASSETS).join(", ")}\`)
}
const pkg = \`${npmName}-\${asset}\`
let binary = null
try {
  binary = join(dirname(createRequire(import.meta.url).resolve(\`\${pkg}/package.json\`)), "bin", ${JSON.stringify(bin)})
} catch {}
if (binary === null || !existsSync(binary)) {
  refuse(\`\${pkg} is not installed. npm installs it for this platform unless optional dependencies are omitted (--omit=optional); reinstall ${npmName}\`)
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })
if (result.error) {
  refuse(\`could not run \${binary}: \${result.error.message}\`)
}
if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)
`
}

/** `npm pack <dir>` into <out>, returning the path of the tarball it wrote. */
const npmPack = (dir, out) => {
  const json = run("npm", ["pack", dir, "--pack-destination", out, "--ignore-scripts", "--json"])
  return path.join(out, JSON.parse(json)[0].filename)
}

/**
 * Pack the project for npm exactly as `npm publish` would (its `files` and
 * .npmignore decide what ships), then unpack it, let `extend` change the
 * unpacked package, and pack that. `private` is dropped: it keeps an
 * accidental `npm publish` from a checkout out of the registry, and the
 * release is the deliberate one. The checked-in package.json never changes.
 */
const repack = (out, version, extend) => {
  const manifest = readJson("package.json")
  if (manifest.version !== version) {
    fail(`package.json's version is ${manifest.version}, not ${version}`)
  }
  fs.mkdirSync(out, { recursive: true })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "release-npm-"))
  try {
    run("tar", ["-xzf", npmPack(".", work), "-C", work])
    const dir = path.join(work, "package")
    const packed = readJson(path.join(dir, "package.json"))
    packed.private = undefined
    extend(dir, packed)
    writeJson(path.join(dir, "package.json"), packed)
    return npmPack(dir, path.resolve(out))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** A library's npm package: the project's source, as `npm publish` would pack it. */
export const libraryPackage = (out, version) => repack(out, version, () => {})

/**
 * An app's main npm package: the project with the launcher as its `bin` and
 * one optionalDependencies pin per platform package, so the checked-in
 * package.json never names a package that is not published yet.
 */
export const mainPackage = (out, bin, version, assets) => {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(bin)) {
    fail(`bin "${bin}" is not a command name`)
  }
  const manifest = readJson("package.json")
  if (manifest.optionalDependencies !== undefined) {
    fail("package.json declares optionalDependencies; the release writes the platform pins itself")
  }
  if (manifest.bin !== undefined) {
    fail("package.json declares bin; the release writes the launcher itself")
  }
  for (const asset of assets) {
    if (!(asset in TARGETS)) {
      fail(`unknown target ${asset}`)
    }
  }
  return repack(out, version, (dir, packed) => {
    const launcherPath = `bin/${bin}.mjs`
    if (fs.existsSync(path.join(dir, launcherPath))) {
      fail(`the package already ships ${launcherPath}`)
    }
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
    fs.writeFileSync(path.join(dir, launcherPath), launcher(manifest.name, bin), { mode: 0o755 })
    packed.bin = { [bin]: launcherPath }
    if (Array.isArray(packed.files)) {
      packed.files = [...packed.files, launcherPath]
    }
    packed.optionalDependencies = Object.fromEntries(
      [...new Set(assets)].sort().map((asset) => [`${manifest.name}-${asset}`, version])
    )
  })
}

// --- Homebrew -----------------------------------------------------------------

/** Homebrew's class name for a formula name: `my-tool` -> `MyTool`. */
export const formulaClass = (name) => {
  if (!/^[a-z0-9][a-z0-9+_.-]*$/.test(name)) {
    fail(`"${name}" is not a Homebrew formula name`)
  }
  return name
    .split(/[-_.]/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
    .replace(/\+/g, "x")
}

const ruby = (text) => JSON.stringify(text)

/**
 * A formula installing the release tarballs: everything in the tarball goes
 * to libexec (dot-directories included), and the command is an exec script
 * rather than a symlink, so the binary always runs by its absolute path.
 */
export const formula = (flags) => {
  need(flags, "name", "bin", "version", "tag", "repo", "summary", "sums")
  const sums = parseSums(fs.readFileSync(flags.sums, "utf8"))
  const assets = releasedAssets(sums, flags.bin, flags.version)
  if (assets.length === 0) {
    fail(`${flags.sums} lists no ${flags.bin} tarball for ${flags.version}`)
  }
  const block = (os, cpu) => {
    const asset = assets.find((a) => TARGETS[a].brew[0] === os && TARGETS[a].brew[1] === cpu)
    if (asset === undefined) {
      return []
    }
    const file = tarballName(flags.bin, flags.version, asset)
    return [
      `    on_${cpu} do`,
      `      url ${ruby(releaseUrl(flags.repo, flags.tag, file))}`,
      `      sha256 ${ruby(sums.get(file))}`,
      "    end",
    ]
  }
  const system = (os) => {
    const inner = [...block(os, "arm"), ...block(os, "intel")]
    return inner.length === 0 ? [] : [`  on_${os} do`, ...inner, "  end", ""]
  }
  return [
    `# Generated by amritk/workflows from ${flags.repo} ${flags.tag}. A release overwrites this file.`,
    `class ${formulaClass(flags.name)} < Formula`,
    `  desc ${ruby(flags.summary)}`,
    `  homepage ${ruby(flags.homepage || `https://github.com/${flags.repo}`)}`,
    `  version ${ruby(flags.version)}`,
    ...(flags.license ? [`  license ${ruby(flags.license)}`] : []),
    "",
    ...system("macos"),
    ...system("linux"),
    "  def install",
    "    libexec.install buildpath.children",
    `    bin.write_exec_script libexec/"bin/${flags.bin}"`,
    "  end",
    "",
    "  test do",
    `    assert_match version.to_s, shell_output("#{bin}/${flags.bin} --version")`,
    "  end",
    "end",
    "",
  ].join("\n")
}

// --- AUR ---------------------------------------------------------------------

const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`

/**
 * A `-bin` AUR package from the release's Linux tarballs: PKGBUILD and the
 * .SRCINFO the AUR requires beside it, which makepkg would generate and which
 * this writes directly, since a GitHub runner has no makepkg. The tarball is
 * installed whole under /opt/<package>, with the command linked into
 * /usr/bin.
 */
export const aur = (dir, flags) => {
  need(flags, "package", "bin", "version", "tag", "repo", "summary", "sums")
  if (!/^[a-z0-9@._+][a-z0-9@._+-]*$/.test(flags.package)) {
    fail(`"${flags.package}" is not an AUR package name`)
  }
  const sums = parseSums(fs.readFileSync(flags.sums, "utf8"))
  const assets = releasedAssets(sums, flags.bin, flags.version).filter((a) => TARGETS[a].aur !== null)
  if (assets.length === 0) {
    fail(`${flags.sums} lists no Linux ${flags.bin} tarball for ${flags.version}`)
  }
  // pkgver may not contain a hyphen; the tarball keeps the real version.
  const pkgver = flags.version.replace(/-/g, "_")
  const url = flags.homepage || `https://github.com/${flags.repo}`
  const license = flags.license || "custom"
  const sources = assets.map((asset) => {
    const file = tarballName(flags.bin, flags.version, asset)
    return { arch: TARGETS[asset].aur, entry: `${file}::${releaseUrl(flags.repo, flags.tag, file)}`, sum: sums.get(file) }
  })
  const top = `${flags.bin}-${flags.version}-$CARCH-linux`
  const pkgbuild = [
    ...(flags.maintainer ? [`# Maintainer: ${flags.maintainer}`] : []),
    `# Generated by amritk/workflows from ${flags.repo} ${flags.tag}. A release overwrites this file.`,
    `pkgname=${flags.package}`,
    `pkgver=${pkgver}`,
    "pkgrel=1",
    `pkgdesc=${shellQuote(flags.summary)}`,
    `arch=(${sources.map((s) => shellQuote(s.arch)).join(" ")})`,
    `url=${shellQuote(url)}`,
    `license=(${shellQuote(license)})`,
    // The binary is the attested release asset; keep its bytes.
    "options=('!strip' '!debug')",
    ...sources.flatMap((s) => [`source_${s.arch}=(${shellQuote(s.entry)})`, `sha256sums_${s.arch}=(${shellQuote(s.sum)})`]),
    "",
    "package() {",
    `  install -d "$pkgdir/opt/$pkgname" "$pkgdir/usr/bin"`,
    `  cp -a "$srcdir/${top}/." "$pkgdir/opt/$pkgname/"`,
    `  ln -s "/opt/$pkgname/bin/${flags.bin}" "$pkgdir/usr/bin/${flags.bin}"`,
    `  if [ -f "$srcdir/${top}/LICENSE" ]; then`,
    `    install -Dm644 "$srcdir/${top}/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"`,
    "  fi",
    "}",
    "",
  ].join("\n")
  const srcinfo = [
    `pkgbase = ${flags.package}`,
    `\tpkgdesc = ${flags.summary}`,
    `\tpkgver = ${pkgver}`,
    "\tpkgrel = 1",
    `\turl = ${url}`,
    ...sources.map((s) => `\tarch = ${s.arch}`),
    `\tlicense = ${license}`,
    "\toptions = !strip",
    "\toptions = !debug",
    ...sources.flatMap((s) => [`\tsource_${s.arch} = ${s.entry}`, `\tsha256sums_${s.arch} = ${s.sum}`]),
    "",
    `pkgname = ${flags.package}`,
    "",
  ].join("\n")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "PKGBUILD"), pkgbuild)
  fs.writeFileSync(path.join(dir, ".SRCINFO"), srcinfo)
  return { pkgbuild, srcinfo }
}

// --- release-please ------------------------------------------------------------

/**
 * Check a release-please config and manifest can drive this workflow, and
 * return the release-please path of the package. The release runs on a
 * `v<version>` tag, so release-please must tag exactly that: one package, no
 * component in the tag, and the `v` kept. The manifest must also agree with
 * package.json, or the first release PR would bump from the wrong version.
 */
export const releasePleaseCheck = (config, manifest, directory, version = "") => {
  const key = path.posix.normalize(directory.replace(/\/+$/, "") || ".").replace(/^\.\//, "")
  const packages = Object.keys(config.packages ?? {})
  if (packages.length !== 1 || packages[0] !== key) {
    fail(
      `the release-please config must hold one package, "${key}" (the directory input); it holds ${JSON.stringify(packages)}. A repository releasing several packages needs per-package tags, which this workflow does not release`,
    )
  }
  const settings = { ...config, ...config.packages[key] }
  if (!settings["release-type"]) {
    fail(`the release-please config sets no release-type for "${key}"; use "node" for a package.json, or "simple"`)
  }
  if (settings["include-component-in-tag"] !== false) {
    fail(
      'the release-please config must set "include-component-in-tag": false, so the tag is v<version>, the tag this workflow releases',
    )
  }
  if (settings["include-v-in-tag"] === false) {
    fail('the release-please config sets "include-v-in-tag": false; this workflow releases only v<version> tags')
  }
  if (settings.draft === true) {
    fail('the release-please config sets "draft": true; a draft release has no tag to run the release on')
  }
  if (typeof manifest[key] !== "string") {
    fail(`the release-please manifest has no version for "${key}"; add { "${key}": "<the current version>" }`)
  }
  if (version !== "" && manifest[key] !== version) {
    fail(`the release-please manifest says "${key}" is ${manifest[key]}, but package.json's version is ${version}`)
  }
  return key
}

// --- command line ---------------------------------------------------------------

const USAGE = `usage: release.mjs rows <targets-json>
       release.mjs platform <stage> <asset> <version> <npm-name>
       release.mjs main <out> <bin> <version> <asset>...
       release.mjs library <out> <version>
       release.mjs formula --name N --bin B --version V --tag T --repo O/R --summary S --sums FILE [--homepage U] [--license L]
       release.mjs aur <dir> --package P --bin B --version V --tag T --repo O/R --summary S --sums FILE [--homepage U] [--license L] [--maintainer M]
       release.mjs release-please <config> <manifest> <path> [<version>]`

const cli = (argv) => {
  const [command, ...args] = argv
  const { flags, rest } = parseFlags(args)
  switch (command) {
    case "rows":
      if (rest.length !== 1) break
      return JSON.stringify(rows(rest[0]))
    case "platform": {
      if (rest.length !== 4) break
      const main = fs.existsSync("package.json") ? readJson("package.json") : {}
      const meta = { license: main.license, repository: main.repository, homepage: main.homepage }
      return JSON.stringify(platformPackage(rest[0], rest[1], rest[2], rest[3], meta))
    }
    case "main":
      if (rest.length < 4) break
      return mainPackage(rest[0], rest[1], rest[2], rest.slice(3))
    case "library":
      if (rest.length !== 2) break
      return libraryPackage(rest[0], rest[1])
    case "formula":
      return formula(flags).trimEnd()
    case "aur":
      if (rest.length !== 1) break
      return aur(rest[0], flags).pkgbuild.trimEnd()
    case "release-please":
      if (rest.length < 3 || rest.length > 4) break
      return releasePleaseCheck(readJson(rest[0]), readJson(rest[1]), rest[2], rest[3])
  }
  fail(USAGE)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(cli(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`release.mjs: ${error.message}`)
      process.exit(error.message === USAGE ? 2 : 1)
    }
    throw error
  }
}
