# workflows

Reusable GitHub Actions workflows. The first is **`release.yml`**: tag a
version and it ships a native command-line program everywhere you turn on.

- **GitHub release**: one tarball per target, `SHA256SUMS`, and signed build
  provenance for every file.
- **npm**: `npm install -g <your-package>` installs the binary for the
  machine (one package per target plus a launcher), published with trusted
  publishing.
- **Homebrew**: a formula written to your tap, for macOS and Linux.
- **AUR**: a `-bin` package with its PKGBUILD and `.SRCINFO`.

It builds on x86_64 and ARM64 Linux and macOS, each on its own runner, and
smoke-tests every binary from its tarball, and from an npm install when npm is
on, before anything is released.

[Nish](https://github.com/amritk/nish) programs need no build step: the
workflow installs the compiler named in `.nish-version` and links
`src/main.ts`. Anything else gives a `build` command.

## Use it

```yaml
# .github/workflows/release.yml in your repository
name: Release

on:
  push:
    tags: ["v*"]
  pull_request:
    paths: [.github/workflows/release.yml]
  workflow_dispatch:

permissions: {}

jobs:
  release:
    uses: amritk/workflows/.github/workflows/release.yml@<commit-sha>
    permissions:
      contents: write
      id-token: write
      attestations: write
    with:
      bin: mytool
      npm: true
      homebrew-tap: you/homebrew-tap
      aur-package: mytool-bin
    secrets: inherit
```

Then push a tag equal to your version: `git tag v1.2.3 && git push origin v1.2.3`.

**Only a `v*` tag releases.** Every other run (a pull request, a manual run)
builds and smoke-tests every target and writes every channel's files, then
stops, so a pull request that changes the release proves it on every platform
first.

**Pin it by commit SHA.** The workflow publishes with your credentials, so
point `uses:` at a reviewed commit, not a branch. Every job checks out this
repository at the same commit the caller resolved, which it reads from its
OIDC token; that is why it needs `id-token: write` even when it publishes
nothing.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `bin` | (required) | The command name and the binary's file name. |
| `directory` | `.` | The project's directory, for a repository holding more than one. |
| `language` | `nish` | `nish` installs the Nish toolchain; `none` installs nothing. |
| `entry` | `src/main.ts` | The Nish entry point, linked when there is no `build`. |
| `nish-version` | `.nish-version` | The nish release to build with. |
| `link-flags` | | Extra flags for `nish <entry> --link`. |
| `setup` | | Shell run before the build on every target. |
| `build` | | Shell that writes the binary to `$OUT` (`ASSET`, `VERSION` set). |
| `targets` | all four | JSON array from `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, `x86_64-darwin`. |
| `include` | `LICENSE README.md THIRD_PARTY_NOTICES.md` | Files copied beside `bin/` in every release. |
| `stage` | | Shell that adds files beside the binary in `$STAGE`. |
| `smoke` | | Shell run against `$BIN`, an installed copy, in an empty directory; `$REPO` is the project. |
| `check-version` | `true` | Require `$BIN --version` to print the version. |
| `summary` | package.json `description` | One line, for Homebrew and the AUR. |
| `homepage` | package.json `homepage`, then the repository | |
| `license` | package.json `license` | An SPDX identifier. |
| `npm` | `false` | Publish to npm under package.json's `name`. |
| `npm-environment` | `npm` | The environment npm trusted publishing names. |
| `homebrew-tap` | | `owner/homebrew-tap`; empty skips Homebrew. |
| `homebrew-formula` | `bin` | The formula's name. |
| `aur-package` | | The AUR package, such as `mytool-bin`; empty skips the AUR. |
| `aur-maintainer` | | The PKGBUILD's `# Maintainer:` line. |
| `node-version` | `26.13.1` | The Node that packs and publishes. |

A release's tarball is `<bin>-<version>-<target>.tar.gz`, holding
`<bin>-<version>-<target>/bin/<bin>`, the `include` files, and whatever
`stage` added.

The version is the tag without its `v`. With a package.json, its `version`
must equal the tag.

## Channels

### npm

The project's own package is published with a `bin` launcher added, and one
`<name>-<target>` package per target holding the binary, each limited to its
platform with `os` and `cpu`. npm installs only the one that matches, the way
esbuild ships. The checked-in package.json stays as it is: the release adds the
launcher and the platform pins when it packs, and drops `private`.

Trusted publishing cannot create a package, so the first release needs a
token:

1. Add an npm token with publish rights as the `NPM_TOKEN` secret, and release.
2. On npmjs.com, for the main package and each platform package, add a
   trusted publisher: your repository, **your** workflow file (the caller,
   such as `release.yml`, not this repository's), and the environment `npm`.
3. Delete the `NPM_TOKEN` secret. Later releases publish with OIDC.

### Homebrew

The formula installs the tarball under `libexec` and puts an exec script on
`PATH`, so the binary runs by its absolute path and finds files beside it. Set
`homebrew-tap` and a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with
contents read and write on the tap repository. Users run
`brew install you/tap/<formula>`.

### AUR

The `-bin` package installs the Linux tarball under `/opt/<package>` and links
the command into `/usr/bin`. Create an AUR account, add its public SSH key
there, and set `AUR_SSH_KEY` to the private key. The first release creates
the package. The job pushes only to a server presenting the host key Arch
Linux published for aur.archlinux.org.

### Private repositories

A private repository can release to GitHub and npm, without provenance or
attestations, which GitHub does not offer for private user repositories.
Homebrew and the AUR are refused, because their users download the release
tarballs signed out.

## Developing

`node --test 'tools/*.test.mjs'` runs the packaging tools' tests. CI also runs
the release workflow on [`test/hello`](test/hello) with every channel on, as a
dry run.
