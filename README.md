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
  - **AUR**: a `-bin` package.
- **`library`** ships the package's source to npm and to a GitHub release with
  provenance. A [Nish](https://github.com/amritk/nish) library is published as
  source, so nothing is built.

A Nish app needs no build configuration: the workflow installs the compiler
pinned in `.nish-version` and links `src/main.ts`. Other languages give a
`build` command.

## Use it

Add one file. This is the whole of it for a Nish app on npm and Homebrew:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push: { tags: ["v*"] }
  pull_request:
permissions: {}
jobs:
  release:
    uses: amritk/workflows/.github/workflows/release.yml@<commit-sha> # v1
    permissions: { contents: write, id-token: write, attestations: write }
    with:
      npm: true
      homebrew-tap: you/homebrew-tap
```

A Nish library is `with: { mode: library }`. Then release by pushing a tag
equal to package.json's version: `git tag v1.2.3 && git push origin v1.2.3`.

**Only a `v*` tag releases.** Any other run (a pull request, a manual run)
builds and smoke-tests every target and writes every channel's files, then
stops, so a pull request proves the release on every platform first.

To keep the pin current, let Dependabot propose updates:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

## Security

- **Pin by commit SHA.** The workflow publishes as your repository, so point
  `uses:` at a reviewed commit. Every job checks out this repository at that
  same commit, which it reads from its OIDC token, so the scripts it runs are
  the ones you pinned; that is also why it needs `id-token: write` on every run.
- **Your code never runs next to a credential.** The jobs that run your
  repository's code (`test`, `setup`, `build`, `stage`, `smoke`) can only read
  the repository and hold no secret. The jobs that publish run none of your
  code: they republish the files the build produced, checked against the
  release's `SHA256SUMS`.
- **Each credential reaches one job.** Keep secrets in GitHub environments,
  not repository secrets: `NPM_TOKEN` in `npm`, `HOMEBREW_TAP_TOKEN` in
  `homebrew`, `AUR_SSH_KEY` in `aur`. A job of this workflow that names an
  environment reads its secrets directly, so the caller passes none. In each
  environment's settings, limit deployments to tags matching `v*`, and add
  required reviewers if a person should approve every publish.
- **npm uses trusted publishing.** There is no npm token after a package's
  first release, and every version carries npm provenance.

## Setting up a repository

Once per repository, in **Settings, Environments**:

1. Create an environment for each channel you turn on: `npm`, `homebrew`,
   `aur`.
2. In each, under **Deployment branches and tags**, choose selected branches
   and tags and add the tag rule `v*`, so only a release tag can use its
   secret. Add required reviewers if a person should approve every publish.
3. Add that channel's secret to it, as its section below describes.

Then add the workflow file from [Use it](#use-it), and optionally
`.github/dependabot.yml`. Nothing else in the repository changes. A pull
request that touches the workflow file runs the whole release as a dry run.

## npm

In app mode the project's own package is published with a `bin` launcher
added, and with one `<name>-<target>` package per target holding the binary,
limited to its platform with `os` and `cpu`, so npm installs only the one that
matches (the way esbuild ships). The checked-in package.json does not change:
the release adds the launcher and the platform pins when it packs, and drops
`private`.

Trusted publishing cannot create a package, so each package's first release
uses a token:

1. Create a granular npm token that can publish, store it as `NPM_TOKEN` in the
   `npm` environment, and release.
2. On npmjs.com, for every package the release published (in app mode, the
   main package and each `<name>-<target>`), add a trusted publisher: your
   repository, **your** workflow file (`release.yml`, the file that has
   `uses:`, not this repository's), and the environment `npm`.
3. Delete `NPM_TOKEN`. Every later release publishes through OIDC.

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

Each release commits `Formula/<bin>.rb` to the tap's default branch. The
formula installs the tarball under `libexec` and puts an exec script on
`PATH`, so the binary runs by its absolute path and can find files beside it.

## AUR

1. Pick a package name ending in `-bin` that is free on
   [aur.archlinux.org](https://aur.archlinux.org/packages), and check that no
   Arch package already installs a `/usr/bin/<bin>`.
2. Make a key used only for this: `ssh-keygen -t ed25519 -N "" -f aur`.
   Add `aur.pub` to your AUR account (My Account, SSH Public Key).
3. Store the private key, the contents of `aur`, as `AUR_SSH_KEY` in the `aur`
   environment, set `aur-package: <name>-bin`, and delete the local copy.

The first release creates the package. It installs the Linux tarball under
`/opt/<package>` and links the command into `/usr/bin`. The job pushes only to
a server presenting the host key Arch Linux published for aur.archlinux.org.

## Private repositories

A private repository can release to GitHub and npm, without attestations or
npm provenance, which GitHub offers only to public repositories. Homebrew and
the AUR are refused, because their users download the release tarballs signed
out.

## Inputs

Everything is optional except where noted.

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `app` | `app` or `library`. |
| `bin` | package.json `name`, unscoped | The command, and the binary's file name. |
| `directory` | `.` | The project's directory, for a repository holding more than one. |
| `test` | | Shell run once on Linux before anything is built or packed. |
| `language` | `nish` | `nish` installs the Nish toolchain; `none` installs nothing. |
| `entry` | `src/main.ts` | The Nish entry point, linked when there is no `build`. |
| `nish-version` | `.nish-version` | The nish release to build with. |
| `link-flags` | | Extra flags for `nish <entry> --link`. |
| `setup` | | Shell run before the build on every target. |
| `build` | | Shell that writes the binary to `$OUT` (`ASSET`, `VERSION` set). |
| `targets` | all four | JSON array from `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, `x86_64-darwin`. |
| `include` | `LICENSE README.md THIRD_PARTY_NOTICES.md` | Files copied beside `bin/` in every tarball. |
| `stage` | | Shell that adds files beside the binary in `$STAGE`. |
| `smoke` | | Shell run against `$BIN`, an installed copy, in an empty directory; `$REPO` is the project. |
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
| `node-version` | `26.13.1` | The Node that packs and publishes. |

The version is the tag without its `v`; with a package.json, its `version`
must equal the tag. An app's tarball is `<bin>-<version>-<target>.tar.gz`,
holding `<bin>-<version>-<target>/bin/<bin>`, the `include` files, and
whatever `stage` added.

## Developing

`node --test 'tools/*.test.mjs'` runs the packaging tools' tests. CI also runs
the release workflow as a dry run on [`test/hello`](test/hello), once as an app
with every channel on and once as a library.
