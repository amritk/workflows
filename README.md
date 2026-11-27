# workflows

Reusable GitHub Actions workflows. The first is **`release.yml`**: push a
version tag and it ships your package everywhere you turn on, with the least
code in your repository and no long-lived credentials where it can avoid them.

It has two modes:

- **`app`** builds a native program on x86_64 and ARM64 Linux and macOS (one
  runner each), smoke-tests every binary, and ships it as:
  - a **GitHub release**: one tarball per target, `SHA256SUMS`, and signed
    build provenance for every file;
  - **npm**: `npm install -g <package>` installs the binary for the machine
    (one package per target plus a launcher);
  - **Homebrew**: a formula in your tap, for macOS and Linux;
  - **AUR**: a `-bin` package;
  - with `wasm`, a **`wasm32-wasi` module** too: attached to the release, and
    on npm as a package that runs the same command on any platform Node runs
    on ([WebAssembly](#webassembly)).
- **`library`** ships the package's source to npm and to a GitHub release with
  provenance. A [Nish](https://github.com/amritk/nish) library is published as
  source, so nothing is built.

A Nish app needs no build configuration: the workflow installs the compiler
pinned in `.nish-version` and links `src/main.ts`. Other languages give a
`build` command.

You cut a release by pushing a `v*` tag, or let **release-please** cut them
from your conventional commits ([Versioning](#versioning)).

Contents: [Use it](#use-it) ·
[Setting up a repository](#setting-up-a-repository) ·
[What a release does](#what-a-release-does) ·
[Versions and prereleases](#versions-and-prereleases) ·
[Versioning](#versioning) ·
[Security](#security) · [npm](#npm) · [WebAssembly](#webassembly) ·
[Homebrew](#homebrew) · [AUR](#aur) ·
[Private repositories](#private-repositories) · [Hooks](#hooks) ·
[Inputs](#inputs) · [Verifying a release](#verifying-a-release) ·
[Troubleshooting](#troubleshooting) ·
[setup-nish on its own](#setup-nish-on-its-own) ·
[Conventional PR titles](#conventional-pr-titles) ·
[Release train](#release-train) ·
[PR description delta](#pr-description-delta) ·
[Maintaining this repository](#maintaining-this-repository)

## Use it

Add one file. This is the whole of it for a Nish app on npm and Homebrew:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push: { tags: ["v*"] }
  pull_request: { paths: [.github/workflows/release.yml, .nish-version] }
  workflow_dispatch:
permissions: {}
jobs:
  release:
    uses: amritk/workflows/.github/workflows/release.yml@<commit-sha> # v1.0.0
    permissions: { contents: write, id-token: write, attestations: write }
    with:
      npm: true
      homebrew-tap: you/homebrew-tap
```

A Nish library is `with: { mode: library }`. Release by pushing a tag equal to
package.json's version: `git tag v1.2.3 && git push origin v1.2.3`.

**Only a `v*` tag releases.** Any other run builds and smoke-tests every
target and writes every channel's files, then stops, so a pull request proves
the release on every platform before a tag does. The `paths` filter keeps that
dry run (four runners, two of them macOS) to pull requests that change the
release; add the files your hooks use, or drop the filter to dry-run every
pull request. `workflow_dispatch` lets you start a dry run by hand from the
Actions tab.

The three permissions are the most the workflow ever uses; each job takes only
what it needs from them (see [What a release does](#what-a-release-does)).

To keep the pin current, let Dependabot propose updates:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

## Setting up a repository

Once per repository, in **Settings, Environments**:

1. Create an environment for each channel you turn on: `npm`, `homebrew`,
   `aur`. (The names are inputs, if yours differ.)
2. In each, under **Deployment branches and tags**, choose selected branches
   and tags and add the tag rule `v*`, so only a release tag can use its
   secret. Add required reviewers if a person should approve every publish.
3. Add that channel's secret to it, as its section below describes.

Then add the workflow file from [Use it](#use-it), and optionally
`.github/dependabot.yml`. Nothing else in the repository changes: a Nish app
needs its `.nish-version` and a `src/main.ts` that answers `--version` with the
version, and a package.json if it publishes to npm.

## What a release does

| Job | Runs on | Can | Runs your code | Secret |
| --- | --- | --- | --- | --- |
| `plan` | Linux | read the repository; request an OIDC token | no | none |
| `check` | Linux | read the repository | `test` | none |
| `build` | one runner per target | read the repository | `setup`, `build`, `stage`, `smoke` | none |
| `wasm` | Linux, with `wasm` | read the repository | `setup`, `wasm-build`, `smoke` | none |
| `release` | Linux | write releases; sign attestations | no | none |
| `npm` | Linux, environment `npm` | request an OIDC token | no | `NPM_TOKEN`, first publish only |
| `homebrew` | Linux, environment `homebrew` | read | no | `HOMEBREW_TAP_TOKEN` |
| `aur` | Linux, environment `aur` | read | no | `AUR_SSH_KEY` |

1. **plan** reads which commit of this workflow is running from its OIDC
   token, works out the version, the mode and the targets, and refuses a
   configuration that cannot work before anything is built.
2. **check** runs the `test` hook once, with the Nish toolchain when it is
   pinned.
3. **build** (app mode), on each target's runner: checks the runner is the
   machine the target names, installs Nish, runs `setup`, links the binary (or
   runs `build`), copies the `include` files beside it, runs `stage`, and packs
   `<bin>-<version>-<target>.tar.gz`. It unpacks that tarball, checks
   `<bin> --version`, and runs `smoke`. With npm on, it also packs the platform
   package and the launcher package, installs both into an empty project,
   checks the installed command execs the binary directly, and runs the
   version check and `smoke` again through it.
4. **wasm** (app mode with `wasm`), on Linux: installs Nish with the WASI
   sysroot, runs `setup`, links the `wasm32-wasi` module (or runs
   `wasm-build`), and checks `<bin> --version` and runs `smoke` through the
   command its npm package installs, under Node's WASI. With npm on, it packs
   that package and checks the command installed on its own and through the
   launcher.
5. **release** gathers every target's files, packs the npm package, writes
   `SHA256SUMS`, checks the Homebrew formula and the PKGBUILD can be written,
   then on a tag signs build provenance for every file and creates the GitHub
   release, with notes generated from the pull requests since the last one (or
   adds the files to the release that already exists, such as release-please's).
6. **npm** downloads the packages from the release, checks them against
   `SHA256SUMS`, and publishes the platform packages (and the wasm package)
   first and the main package last, skipping any version already on the registry, so a re-run finishes a
   half-done publish.
7. **homebrew** writes the formula and commits it to the tap.
8. **aur** writes the PKGBUILD and `.SRCINFO` and pushes them to the AUR.

Steps 5 to 8 publish only on a tag; on any other run, step 5 stops after the
checks and 6 to 8 are skipped. If a job fails, nothing after it runs, so a
build that fails on one target publishes nothing anywhere.

## Versions and prereleases

The version is the tag without its `v`. With a package.json, its `version` must
equal the tag, or the release stops in `plan`. Off a tag, the version is
package.json's, or `0.0.0` with no package.json (and then `--version` is not
checked).

A version with a hyphen, such as `1.2.0-rc.1`, is a **prerelease**: the GitHub
release is marked as one, npm publishes it under the `next` dist-tag rather
than `latest` (`npm install <package>@next`), and Homebrew and the AUR are
skipped, so their users stay on the last full release.

## Versioning

With the default, `versioning: tag`, a person cuts each release by pushing the
tag. To have [release-please](https://github.com/googleapis/release-please)
cut them instead, call `release-please.yml` beside `release.yml` in the same
file, and run it on pushes to the default branch:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push: { branches: [main], tags: ["v*"] }
  pull_request: { paths: [.github/workflows/release.yml, .nish-version] }
  workflow_dispatch:
permissions: {}
jobs:
  release-please:
    uses: amritk/workflows/.github/workflows/release-please.yml@<commit-sha> # v1.0.0
    permissions: { contents: write, pull-requests: write, issues: write, actions: write }
  release:
    uses: amritk/workflows/.github/workflows/release.yml@<commit-sha> # v1.0.0
    permissions: { contents: write, id-token: write, attestations: write }
    with:
      versioning: release-please
      npm: true
```

Neither job needs a condition: `release-please.yml` acts only on a push to the
default branch, and `release.yml` does nothing on one. Then add release-please's
two files. `.github/release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "node",
      "include-component-in-tag": false,
      "bump-minor-pre-major": true
    }
  }
}
```

`.github/.release-please-manifest.json`, holding the current version, the one
in package.json:

```json
{ ".": "1.2.3" }
```

From then on:

1. **Every push to the default branch** updates one open release PR: the next
   version, worked out from the commits since the last release (`fix` is a
   patch, `feat` a minor, `!` or a `BREAKING CHANGE` footer a major; before
   1.0, `bump-minor-pre-major` makes a breaking change a minor), with
   `CHANGELOG.md`, package.json (`release-type: node`) and any `extra-files`
   bumped.
2. **Merging the release PR** makes release-please tag `v<version>` and create
   the GitHub release with that version's changelog as its notes. Then
   `release-please.yml` starts your workflow file on the tag.
3. **That run is an ordinary tag release**: `release.yml` builds, attaches its
   files to the release release-please created (keeping its notes) and
   publishes. The run's ref is the tag, so an environment limited to `v*` tags
   admits it, and npm trusted publishing sees your workflow file as always.

release-please tags with `GITHUB_TOKEN`, and an event made with `GITHUB_TOKEN`
starts no workflow run, except a dispatch. That is why `release-please.yml`
starts the release itself (`gh workflow run`) and why your file needs
`workflow_dispatch`. It needs no other token.

`release.yml` checks the config on every run, pull requests included, so a
mistake stops a pull request rather than a release. It requires one package, at
`directory`; `include-component-in-tag: false` (release-please's default puts
the package's name in the tag, and the release runs only on `v<version>`); no
`include-v-in-tag: false` and no `draft: true`; and the manifest's version equal
to package.json's.

- **Squash-merge with conventional pull request titles.** release-please reads
  the commits on the default branch, so the title is what picks the version and
  writes the changelog. A feature merged as `chore:` ships without a bump.
- **A version in another file**, such as a constant the program prints for
  `--version`: list the file in the package's `extra-files` and end its line
  with the comment `x-release-please-version`. release-please bumps the version
  on that line.
- **Checks do not run on the release PR on their own.** release-please opens it
  with `GITHUB_TOKEN`, which starts no `pull_request` run. If the branch requires
  status checks, close and reopen the PR to run them, or leave the
  `release-please--*` branches out of the requirement.
- **A repository with releases but no tag for the current version** (a version
  published by hand, say): set `"bootstrap-sha"` in the config to the commit it
  was released from, so the first release PR starts there.
- **Prereleases** are release-please's `"prerelease": true` with
  `"versioning": "prerelease"`; a hyphenated version publishes to npm's `next`
  as above.
- **Changesets** is not supported yet; `versioning: changesets` is reserved for
  it. This workflow releases one package per repository, tagged `v<version>`,
  and a monorepo releasing several packages needs per-package tags.

`release-please.yml`'s one job holds `contents`, `pull-requests`, `issues` and
`actions: write`, and only it does: it runs the pinned release-please action and
`gh workflow run`, none of your code, and reads no secret. Its inputs are
`config-file` and `manifest-file` (the defaults above) and `directory` (match
`release.yml`'s).

## Security

- **Pin by commit SHA.** The workflow publishes as your repository, so point
  `uses:` at a reviewed commit. Every job checks out this repository at that
  same commit, which it reads from its OIDC token, so the scripts it runs are
  the ones you pinned; that is also why it needs `id-token: write` on every run.
- **Your code never runs next to a credential.** The jobs that run your
  repository's code (the hooks) can only read the repository and hold no
  secret. The jobs that publish run none of your code: they republish the
  files the build produced, checked against the release's `SHA256SUMS`, and
  pack with npm's install scripts off.
- **Each credential reaches one job.** Keep secrets in GitHub environments,
  not repository secrets: `NPM_TOKEN` in `npm`, `HOMEBREW_TAP_TOKEN` in
  `homebrew`, `AUR_SSH_KEY` in `aur`. A job of this workflow that names an
  environment reads its secrets directly, so the caller passes none. Limit each
  environment to tags matching `v*`.
- **npm uses trusted publishing.** There is no npm token after a package's
  first release, and in a public repository every version carries npm
  provenance.
- **Every action this workflow uses is pinned by commit SHA**, and the AUR job
  checks the server's host key against the one Arch Linux published.

## npm

In app mode the project's own package is published with a `bin` launcher
added, and with one `<name>-<target>` package per target holding the binary
(the way esbuild ships). The checked-in package.json does not change: the
release adds the launcher, a postinstall script and the platform pins when it
packs, and drops `private`, which keeps an accidental `npm publish` from a
checkout out of the registry. Do not declare `bin` or `optionalDependencies`
yourself; the release writes both and refuses a package.json that has them. A
`postinstall` of your own (a git hook installer such as husky or lefthook)
keeps running in your checkout, and the published package carries the
release's instead, so it never runs on your users' machines.

How npm picks the binary: the main package lists every platform package in
`optionalDependencies`, and each platform package names the machine it is for
with `os` and `cpu` (and `libc: ["glibc"]` on Linux, since the binaries are
linked against glibc). npm compares those with the machine it is installing
on and skips every package that does not match, so it downloads only one
binary. A lockfile still lists them all, so it works on every machine.

How the command reaches the binary: npm can link a command only to a file in
the package that declares it, and the binary is in another package. So the
command is first a small node launcher, and the postinstall script then
replaces it with a one-line `/bin/sh` script that execs the platform's binary
where it lies, in its own package (the approach
[nish](https://github.com/amritk/nish) takes for its own compiler). So
`npm install -g <name>` leaves a command on `PATH` that runs the binary with no
node in between: 1 to 2 ms a run, where the launcher adds a node start, about
30 ms. The binary runs beside the files the release staged with it (`include`,
`stage`), so a program that finds data by its own path keeps finding it.

The binary's path is fixed when the package installs. If `node_modules` is
moved without reinstalling, the command says so and exits 2, and
`npm rebuild <name>` points it at the binary again. When install scripts do
not run (`--ignore-scripts`, pnpm 10 and bun by default, Yarn PnP), on Windows,
or on musl, the launcher stays, and works at that 30 ms. pnpm 9 runs it, and
its command runs the binary through the same script.

The launcher runs the platform's binary by its absolute path and passes its
exit code through. On a machine with no published binary, or an install made
with `--omit=optional`, it says which package is missing and exits 2; with
`wasm`, it first runs `<name>-wasm32-wasi` if that is installed, and otherwise
names it as the package to install ([WebAssembly](#webassembly)).

In library mode the project is packed exactly as `npm publish` would pack it,
minus `private`.

Trusted publishing cannot create a package, so each package's first release
uses a token:

1. Create a granular npm token that can publish, store it as `NPM_TOKEN` in the
   `npm` environment, and release.
2. On npmjs.com, for every package the release published (in app mode, the
   main package, each `<name>-<target>`, and `<name>-wasm32-wasi` with
   `wasm`), add a trusted publisher: your
   repository, **your** workflow file (`release.yml`, the file that has
   `uses:`, not this repository's), and the environment `npm`.
3. Delete `NPM_TOKEN`. Every later release publishes through OIDC.

## WebAssembly

With `wasm: true`, an app is also linked as one `wasm32-wasi` module and
shipped beside the native binaries, the way
[scalar/formatters](https://github.com/scalar/formatters) ships real tools as
WebAssembly that needs nothing but Node:

- The release attaches `<bin>-<version>-wasm32-wasi.wasm`, listed in
  `SHA256SUMS` and covered by the build provenance. Any WASI host runs it:
  `wasmtime tool-1.2.3-wasm32-wasi.wasm --version`.
- With `npm`, `<name>-wasm32-wasi` is published as well.
  `npm install -g <name>-wasm32-wasi` installs the same `<bin>` command on
  any platform Node 20 or newer runs on, Windows and unusual CPUs included.
  It runs the module under Node's built-in WASI, with the arguments,
  environment, standard streams and exit status the native binary has. The
  package exports the module as `<name>-wasm32-wasi/wasm`, for a host of your
  own, such as a page or a worker with a WASI shim.

The main package does not depend on the wasm package, so a machine that has a
prebuilt binary never downloads the module. The launcher prefers the native
binary. When no platform package is installed (an unsupported platform, or
`--omit=optional`) it runs `<name>-wasm32-wasi` under the same `node` if that
is installed, and otherwise tells the user to install it.

A Nish app needs no other configuration: the `wasm` job installs the WASI
sysroot and runs `nish <entry> --link <module> --profile wasi` with
`wasm-link-flags`. `link-flags` are not passed, because a native profile such
as `--profile size` would replace `wasi`. Other languages give `wasm-build`,
which writes the module to `$OUT` (for example, `cargo build --release
--target wasm32-wasip1` followed by a copy).

How the module differs from a native binary:

- It sees the working directory and what is below it, and nothing else. An
  absolute path, or one that climbs out with `..`, does not resolve. Node's
  WASI preopens `.`, as nish's own WASI host does.
- It is built once, on Linux, so `setup` runs there too, with `ASSET` set to
  `wasm32-wasi`. `stage` does not run, because a module cannot read files
  beside itself. The `include` files go into the npm package.
- The program has to build under nish's `wasi` profile; see nish's
  [interop guide](https://github.com/amritk/nish/blob/main/docs/guide/using-nish/interop.md).

Node's WASI is not a security boundary, so the wasm build is not a sandbox
for code you do not trust.

## Homebrew

Homebrew installs from a **tap**, a separate repository holding formulas. One
tap serves every program you release, so you make it once:

1. Create a public repository named `homebrew-<something>`, such as
   `you/homebrew-tap`. The `homebrew-` prefix is what lets users write
   `brew install you/tap/<bin>`. It can start empty.
2. Create a fine-grained personal access token (GitHub settings, Developer
   settings, Fine-grained tokens) with **Repository access** set to that one
   tap repository and **Contents: Read and write**, nothing else. Give it an
   expiry and note when to rotate it.
3. In each repository that releases, store the token as `HOMEBREW_TAP_TOKEN`
   in its `homebrew` environment, and set `homebrew-tap: you/homebrew-tap`.
   Homebrew also needs a `summary` (or package.json `description`).

Each release commits `Formula/<formula>.rb` to the tap's default branch, as
`github-actions[bot]`. The formula names each target's tarball and digest,
installs the tarball under `libexec`, and puts an exec script on `PATH`, so the
binary runs by its absolute path and can find files beside it. Its `test`
block runs `<bin> --version`. Users run `brew install you/tap/<formula>`.

## AUR

1. Pick a package name ending in `-bin` that is free on
   [aur.archlinux.org](https://aur.archlinux.org/packages), and check that no
   Arch package already installs a `/usr/bin/<bin>`.
2. Make a key used only for this: `ssh-keygen -t ed25519 -N "" -f aur`.
   Add `aur.pub` to your AUR account (My Account, SSH Public Key).
3. Store the private key, the contents of `aur`, as `AUR_SSH_KEY` in the `aur`
   environment, set `aur-package: <name>-bin`, and delete the local copy.
   The AUR also needs a `summary` (or package.json `description`); set
   `aur-maintainer` to put your name in the PKGBUILD.

The first release creates the package. It covers the x86_64 and aarch64 Linux
targets you build, installs the tarball under `/opt/<package>`, links the
command into `/usr/bin`, installs `LICENSE` when the tarball has one, and keeps
the binary's bytes (no strip). A prerelease's hyphen becomes an underscore in
`pkgver`. The job pushes only to a server presenting the host key Arch Linux
published for aur.archlinux.org.

## Private repositories

A private repository can release to GitHub and npm, without attestations or
npm provenance, which GitHub offers only to public repositories. Homebrew and
the AUR are refused, because their users download the release tarballs signed
out. Publishing a package to npm makes whatever it ships public, whatever the
repository's visibility.

## Hooks

Hooks are shell, run with `bash -e` (`build` with `bash -euo pipefail`). They
run only in jobs that hold no secret.

| Hook | When | Where | Variables |
| --- | --- | --- | --- |
| `test` | once, on Linux, before anything else | `directory` | `nish` on `PATH` when pinned |
| `setup` | on every target (and the wasm build), before the build | `directory` | `ASSET`, `VERSION`, `BIN` (the name), `REPO` |
| `build` | on every target, instead of the Nish link | `directory` | as `setup`, plus `OUT`: write the executable there |
| `wasm-build` | in the wasm build, instead of the Nish `wasi` link | `directory` | as `setup`, plus `OUT`: write the `wasm32-wasi` module there |
| `stage` | on every target, after the build | `directory` | as `setup`, plus `STAGE`: the directory being packed |
| `smoke` | on every target (and the wasm build), after unpacking, and again after the npm install | an empty directory | `BIN`: the installed binary, or the wasm package's command; `REPO`; `ASSET`; `VERSION` |

`REPO` is the absolute path of `directory` in the checkout; `ASSET` is the
target (`x86_64-linux`); `VERSION` is the version being built. On Linux the
build has LLVM 18's `clang`, `lld`, `wasm-ld`, `opt`, `llc` and `llvm-as` on
`PATH`, and the wasm build also has the WASI sysroot, at `WASI_SYSROOT`; on
macOS it uses Xcode's `clang`.

## Inputs

Everything is optional except where noted.

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `app` | `app` or `library`. |
| `versioning` | `tag` | `tag`, or `release-please` with `release-please.yml` beside it ([Versioning](#versioning)). |
| `release-please-config` | `.github/release-please-config.json` | With `versioning: release-please`, the config, from the repository root. |
| `release-please-manifest` | `.github/.release-please-manifest.json` | With `versioning: release-please`, the manifest, from the repository root. |
| `bin` | package.json `name`, unscoped | The command, and the binary's file name. |
| `directory` | `.` | The project's directory, for a repository holding more than one. |
| `test` | | Shell run once on Linux before anything is built or packed. |
| `language` | `nish` | `nish` installs the Nish toolchain; `none` installs nothing. |
| `entry` | `src/main.ts` | The Nish entry point, linked when there is no `build`. |
| `nish-version` | `.nish-version` | The nish release to build with. |
| `link-flags` | | Extra flags for `nish <entry> --link`, such as `--profile size`. |
| `setup` | | Shell run before the build on every target. |
| `build` | | Shell that writes the binary to `$OUT`. |
| `wasm` | `false` | In app mode, also build a `wasm32-wasi` module, attached to the release and, with `npm`, published as `<name>-wasm32-wasi` ([WebAssembly](#webassembly)). |
| `wasm-build` | | Shell that writes the `wasm32-wasi` module to `$OUT`, instead of the Nish `wasi` link. |
| `wasm-link-flags` | | Extra flags for `nish <entry> --link <module> --profile wasi`. |
| `targets` | all four | JSON array from `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, `x86_64-darwin`. |
| `include` | `LICENSE README.md THIRD_PARTY_NOTICES.md` | Files copied beside `bin/` in every tarball; missing ones are skipped. |
| `stage` | | Shell that adds files beside the binary in `$STAGE`. |
| `smoke` | | Shell run against `$BIN`, an installed copy. |
| `check-version` | `true` | Require `$BIN --version` to print the version. |
| `summary` | package.json `description` | One line, for Homebrew and the AUR. |
| `homepage` | package.json `homepage`, then the repository | |
| `license` | package.json `license` | An SPDX identifier. |
| `npm` | `false` (`true` in library mode) | Publish to npm under package.json's `name`. |
| `npm-environment` | `npm` | The environment npm trusted publishing names. |
| `homebrew-tap` | | `owner/homebrew-tap`; empty skips Homebrew. |
| `homebrew-formula` | `bin` | The formula's name. |
| `homebrew-environment` | `homebrew` | The environment holding `HOMEBREW_TAP_TOKEN`. |
| `aur-package` | | The AUR package, such as `mytool-bin`; empty skips the AUR. |
| `aur-maintainer` | | The PKGBUILD's `# Maintainer:` line. |
| `aur-environment` | `aur` | The environment holding `AUR_SSH_KEY`. |
| `node-version` | `26.13.1` | The Node that packs and publishes; npm trusted publishing needs the npm it bundles to be 11.5.1 or newer. |

| Secret | Where | For |
| --- | --- | --- |
| `NPM_TOKEN` | environment `npm` | a package's first npm publish only |
| `HOMEBREW_TAP_TOKEN` | environment `homebrew` | pushing the formula to the tap |
| `AUR_SSH_KEY` | environment `aur` | pushing to the AUR |

A target's runner: `x86_64-linux` on `ubuntu-24.04`, `aarch64-linux` on
`ubuntu-24.04-arm`, `aarch64-darwin` on `macos-15`, `x86_64-darwin` on
`macos-15-intel`.

## Verifying a release

What a user can check, with `gh` and the release's files:

```sh
gh release download v1.2.3 --repo you/tool --pattern 'tool-1.2.3-x86_64-linux.tar.gz' --pattern SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify tool-1.2.3-x86_64-linux.tar.gz --repo you/tool
```

`gh attestation verify` checks the file was built by your repository's
workflow (public repositories only). For npm, `npm audit signatures` in a
project that installed the package checks its provenance.

## Troubleshooting

| The release says | Do this |
| --- | --- |
| needs `id-token: write` from its caller | Give the calling job the three permissions in [Use it](#use-it). A pull request from a fork cannot, so its dry run fails; that is expected. |
| the tag is vX but package.json's version is Y | Tag the version package.json holds, or bump package.json first. |
| the release-please config must … / the release-please manifest … | Fix the config or manifest as the message says ([Versioning](#versioning)). |
| release-please created a release, but its tag is "…", not v&lt;version&gt; | Set `"include-component-in-tag": false`, then delete that release and tag and re-run. |
| `could not create workflow dispatch event` | Add `workflow_dispatch:` to your workflow file's `on:`, and `actions: write` to the release-please job; then run your workflow on the tag from the Actions tab. |
| there is no nish-version input and no .nish-version file | Add `.nish-version` holding the nish release, such as `0.39.0`. |
| `--version` printed "…", which does not name X | Make the program print its version, or set `check-version: false`. |
| the build wrote no executable at `$OUT` | With `build`, write the binary to exactly `$OUT`. |
| the wasm build wrote no module at `$OUT` / is not a WebAssembly module | With `wasm-build`, write the `wasm32-wasi` module to exactly `$OUT`. |
| wasm builds a program as a wasm32-wasi module, so it needs mode app | Drop `wasm` from a library; a Nish library ships as source. |
| this runner is X, but the target is built on Y | GitHub moved a runner label; pin `targets` to the ones that work and report it here. |
| package.json declares bin / optionalDependencies | Remove them; the release writes both. |
| the postinstall script left the launcher in place of X | Report it here, with the build job's log: the install script failed to point the command at the binary. |
| X is not where it was installed; run 'npm rebuild …' | `node_modules` moved after the install; run the `npm rebuild` it names, or reinstall. |
| has never been published, so it cannot trust this workflow yet | Add `NPM_TOKEN` to the `npm` environment for the first release ([npm](#npm)). |
| npm publish fails with 404 or `ENEEDAUTH` after the first release | The trusted publisher must name your repository, your workflow file and the environment `npm` exactly, on every package. |
| HOMEBREW_TAP_TOKEN / AUR_SSH_KEY is not set | Put the secret in the environment the job names (`homebrew`, `aur`), not in repository secrets under another name. |
| Homebrew and the AUR need a public repository | Make the repository public, or turn those channels off. |
| need a one-line summary | Set `summary`, or package.json's `description`. |
| aur.archlinux.org presented host key … | Stop: the server is not the AUR's published one. Check Arch Linux's announcements before changing anything. |

A failed release can be re-run from the Actions tab once the cause is fixed:
`npm` skips versions already published, and the Homebrew and AUR jobs commit
nothing when the file is unchanged. A GitHub release that already exists is
kept, notes and all, and gets the files, replacing any from an earlier run.

## setup-nish on its own

The action that installs Nish works in any workflow, such as a repository's CI:

```yaml
- uses: amritk/workflows/actions/setup-nish@<commit-sha>
  with:
    version: 0.39.0 # or omit it to read .nish-version
```

It installs the release's own `install.sh` from that version's tag, puts
`nish` on `PATH`, and on Linux installs LLVM 18 from apt with the plain tool
names linked onto `PATH`. With `wasi: true` (Linux only) it also installs the
WASI sysroot and compiler-rt's wasm32 builtins and sets `WASI_SYSROOT`, so
`nish --profile wasi` links. Inputs: `version`, `version-file` (default
`.nish-version`), `wasi` (default `false`). Outputs: `version`, `nish` (its
absolute path).

## Conventional PR titles

`actions/pr-title` fails a pull request whose title is not a conventional
commit subject. In a repository that squash-merges, the title becomes the
subject of the commit on `main`, which is what release-please (and nish's own
release-notes generator) read for the release notes and the version bump, so a
title they cannot classify is a change missing from both.

```yaml
# .github/workflows/pr-title.yml
name: PR title
on:
  pull_request:
    types: [opened, edited, reopened, synchronize]
  merge_group:
permissions: {}
jobs:
  check:
    name: conventional title
    runs-on: ubuntu-latest
    steps:
      - uses: amritk/workflows/actions/pr-title@<commit-sha> # v1.x.y
```

The rule is the release-notes generator's own
([`tools/changelog-gen.mjs`](tools/changelog-gen.mjs), which came from
[amritk/nish](https://github.com/amritk/nish)): the action runs its
`--check-subject`, so a title it accepts is one the release notes can file.
For a repository on [the release train](#release-train) it is the very script
that writes those notes.

- `type(scope)!: subject` — the scope and the `!` (a breaking change) are
  optional;
- the type is one with a release-notes section: `feat`, `fix`, `perf`,
  `refactor`, `docs`, `test`, `build`, `ci`, `chore`;
- no full stop at the end: the title is a heading, not a sentence.

`edited` is what clears the check once a title is fixed. A merge-queue run
passes, since the queue merges what was checked on the pull request. The title
reaches the script through the environment, never spliced into a shell, since
anyone opening a pull request writes it.

## Release train

`release-train.yml` versions a package from its conventional commits without
release-please: it is nish's release train, shared. On every push to the
default branch it keeps one `chore(release): <version>` pull request open on
`release/next`, holding the version bump, `changelog/<version>.json` (the
structured record) and the `CHANGELOG.md` section, all written by
[`tools/changelog-gen.mjs`](tools/changelog-gen.mjs) from the subjects since
the last `v*` tag. Merging that pull request is the release: the next run tags
`v<version>` and dispatches your release workflow at the tag. **A human merges
it**; the pull request says so in its first line.

```yaml
# .github/workflows/release-pr.yml
name: Release PR
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: {}
jobs:
  train:
    uses: amritk/workflows/.github/workflows/release-train.yml@<commit-sha>
    permissions: { contents: write, pull-requests: write, actions: write, id-token: write }
    with:
      bootstrap-from-npm: true # tag the published version if there is no v* tag yet
```

Inputs: `bump` (a command run with `VERSION` set that writes the version
everywhere it is held; default: package.json and package-lock.json),
`bootstrap-from-npm` (default `false`), `release-workflow` (default
`release.yml`), `dispatch` (the workflows started at `release/next` so the
Release PR gets checks; default `ci.yml pr-title.yml`), `node-version`.
`id-token: write` is how the job learns which commit of this repository to run
the generator from. Settings, Actions, General, Workflow permissions must allow
GitHub Actions to create pull requests.

Your release workflow, started at the tag, renders the GitHub release notes
from the record the Release PR was reviewed with:

```yaml
- id: notes
  uses: amritk/workflows/actions/release-notes@<commit-sha>
  with: { version: 1.2.3 } # package.json's version
- run: gh release create "$GITHUB_REF_NAME" --verify-tag --notes-file "${{ steps.notes.outputs.file }}"
```

## PR description delta

`actions/pr-delta` keeps a generated markdown block (a benchmark or
bundle-size delta table) in the pull request description: it writes the file to
the job summary and splices it between `<!-- <marker>:start -->` and
`<!-- <marker>:end -->`, replacing the previous run's block and repairing
dangling markers. A pull request from a fork gets the summary only.

```yaml
- uses: amritk/workflows/actions/pr-delta@<commit-sha>
  with:
    file: bench-delta.md
    marker: my-bench-delta
```

The job needs `pull-requests: write`. Measuring is yours: the file is whatever
your compare script writes.

## Maintaining this repository

- `tools/release.mjs` holds the packaging: the target table, the npm packages
  and launcher, the Homebrew formula and the AUR files; `tools/changelog-gen.mjs`
  is the release-notes generator, whose `--check-subject` is the PR-title
  rule; `tools/pr-delta.cjs` splices a block into a PR description. `node --test 'tools/*.test.mjs'` runs their tests.
- CI runs those tests, actionlint over the workflows, and the release workflow
  itself as a dry run on [`test/hello`](test/hello): once as an app on every
  target with every channel on, once as a library, and once as a library with
  `versioning: release-please`, which checks test/hello's release-please
  config. CI never runs on a tag, so it cannot publish `test/hello`, and never
  calls `release-please.yml`, which would open release PRs here.
- To release this repository, merge to `main` with CI green and push a
  `vX.Y.Z` tag. Callers pin the tag's commit SHA with the tag in a comment, the
  form Dependabot updates.
