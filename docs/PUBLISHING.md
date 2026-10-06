# Publishing Agentic Engineering Harness to npm

The package name is `agentic-engineering-harness` and the public CLI commands are `aeh` and `engineering-harness`.

`package.json` is the single source of truth for the AEH version. Runtime CLI version output imports that package metadata; source files and CI must not maintain separate hard-coded version strings.

## Preflight

Every release candidate must pass:

```bash
npm run release:check
```

This runs typecheck, the complete test suite, build and `npm pack --dry-run`.

## Automatic releases from `main`

`.github/workflows/publish.yml` is the single npm publishing workflow. A push to `main` starts an idempotent release pipeline unless the repository variable below is set:

```text
AEH_AUTO_PUBLISH=false
```

The workflow performs the following steps:

1. installs dependencies with `npm ci`;
2. checks whether the current `package.json` version is already present on npm;
3. if the current version is unpublished, it publishes that exact version first;
4. otherwise it derives the next semantic version from commits since the latest `v*` tag:
   - a breaking Conventional Commit (`type!:` or `BREAKING CHANGE:`) -> major;
   - `feat:` -> minor;
   - every other change -> patch;
5. synchronizes `package.json` and `package-lock.json` with `npm version --no-git-tag-version`;
6. runs `npm run release:check` on the exact candidate;
7. commits the version metadata as `chore(release): vX.Y.Z`, pushes it, exposing the release SHA as a job output (no tag is created here);
8. verifies the release COMMIT SHA checkout directly (detached `git fetch origin <sha>` + `checkout <sha>`, package version, packaged-consumer contracts) before anything is published — no tag exists at verify time, so a verify failure leaves NO tag behind;
9. creates the matching Git tag only if absent (`git ls-remote --tags` check; a pre-existing tag fails loudly and is never force-moved, with nothing public yet) and verifies the tag points at the pushed release commit SHA, then publishes the package to npm with provenance only if commit verification is green, then confirms the version is on npm;
10. creates the GitHub Release for the verified and published tag.

The release commit/tag is pushed with GitHub's repository token. GitHub does not recursively trigger ordinary push workflows for pushes created with that `GITHUB_TOKEN`, so the version commit does not create an infinite publish loop.

The repository must allow the workflow identity to write the release metadata commit/tag. If branch rules forbid direct writes to `main`, grant the GitHub Actions identity the appropriate bypass/write permission or set `AEH_AUTO_PUBLISH=false` until the repository rule is adjusted. Source validation remains independent of publication.

## Manual release control

`publish-npm` also supports `workflow_dispatch`. The `bump` input can be:

```text
auto     # Conventional Commit-derived bump
current  # publish current version only if it is not already published
patch
minor
major
```

Manual dispatch is useful for retrying an external npm/OIDC failure or deliberately overriding the automatic bump classification. A `current` retry never creates a GitHub Release without in-workflow verification: the repair path refuses with a clear error instead of creating a verification-skipped Release. A missing Release is only (re)created by the gated `release` job after commit, commit verification (by SHA), tag creation, and npm publication all succeed in one workflow run; it will not fabricate a missing tag for an already-published package. Tag-after-verify lifecycle: a verify failure leaves NO tag (only the bump commit persists, which later runs handle); a pre-existing tag blocks loudly at tag creation pre-publish with nothing public.

## npm authentication

The preferred steady-state path is npm Trusted Publishing with GitHub Actions OIDC. Configure the npm package Trusted Publisher with:

```text
Provider: GitHub Actions
Organization/user: JamesMorales04
Repository: agentic-engineering-harness
Workflow filename: publish.yml
Allowed action: npm publish
```

The workflow grants `id-token: write`, which is required for OIDC. Modern npm clients can exchange the GitHub OIDC identity for short-lived publish authorization, avoiding a long-lived npm write token.

For bootstrap or compatibility, the workflow also accepts an optional GitHub Actions secret named `NPM_TOKEN`. If present, it is exported only for the `npm publish` step. Once Trusted Publishing is verified, prefer removing the long-lived token.

If the package has never been published and npm does not permit Trusted Publisher configuration before first publication, perform one maintainer-authenticated bootstrap publish, then configure the Trusted Publisher above. The automatic workflow will subsequently see that version as published and continue normal semantic versioning.

## Version policy

The root `package.json` version is the canonical release base; `package-lock.json`
is synchronized with it by the release workflow. No release-line version is
maintained in this document. On `main`, an unpublished current package version
is published as-is. When it is already published, `release-version.mjs` selects
the next semantic version from Conventional Commit messages since the latest
release tag, unless a manual bump was requested.

If a PR intentionally changes `package.json` to a version that is not yet on
npm, that candidate version ships before any automatic increment. The workflow
synchronizes both package manifests, runs `release:check` on the synchronized
candidate, and only then commits version metadata and creates a tag. A failed
validation therefore creates no release commit, tag, npm publication, or
GitHub Release.

## What enters the npm tarball

The `files` allowlist in `package.json` publishes:

```text
dist/
templates/
presets/
policies/
schemas/
skills/
docs/
```

plus npm-required package metadata such as `package.json`, README and LICENSE.

Packaged `skills/` and core `policies/` are runtime control-plane assets. In consumer repositories, `aeh init`, `aeh setup`, and `aeh start` reconcile those package assets into `.harness/skills/` and `.harness/policies/core/`. Their copies stay ignored. `.harness/managed-assets.json` is versioned reconciliation metadata: its source and managed hashes let a fresh checkout restore missing assets, upgrade untouched assets, preserve local overrides, and safely retire removed assets.

Consumer bootstrap configuration is declarative and versionable: `.harness/project.yaml`, `.harness/toolchain.yaml`, `.harness/provider-versions.json`, `.harness/agents.source.jsonc`, `.harness/otel-collector.yaml`, and `openspec/config.yaml`. AEH runtime state such as operation, Paseo, run, audit, report, telemetry, controller, delivery, eval, toolchain-state, and managed-asset copies remains ignored. The generated `.config/mise/conf.d/aeh.toml` is ignored; repository reproducibility locks at `.config/mise/mise.lock` and `.config/mise/locks/` remain trackable. Toolchain YAML declares requested versions; `mise.lock` records the resolved versions for reproducible installation. The source checkout's `.harness/toolchain.yaml` is its development toolchain, while `templates/toolchain.yaml` is the consumer starter configuration.

In the AEH source checkout, `package.json` identity plus Git metadata marks the repository as the package source. Init/setup use the tracked root `.harness/project.yaml`, `.harness/toolchain.yaml`, `.harness/agents.source.jsonc`, and `openspec/config.yaml` directly; they do not create consumer copies from `templates/` or reconcile source `skills/` and `policies/` back into `.harness/`. The source-owned OpenSpec config guides AEH's own formal changes. Use the source checkout with `npm ci`, `npm run build`, and `npm run aeh -- start`; it does not need the released `agentic-engineering-harness` package as a dependency of itself.

## Consumer installation

Normal projects should pin AEH as a development dependency:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
```

After the repository has been initialized, a normal:

```bash
npm exec aeh -- start
```

reconciles managed Harness assets before loading the agent topology and starting Paseo.

## Failure policy

A registry/OIDC/permission failure is an external delivery failure, not a reason to rewrite validated engineering history. The release workflow is retry-safe: if the version commit exists but npm publication failed, a manual rerun will attempt the same unpublished version rather than incrementing it again. If npm publication succeeded but GitHub Release creation failed, the gated `release` job recreates it from the verified tag. The `bump=current` repair path never creates a verification-skipped Release; it refuses with a clear error when verification did not run in the same workflow.
Tag-after-verify lifecycle: the version tag is created only after commit verification greens (absent-only, never force-moved). If commit verification fails, no tag exists to delete — only the bump commit persists, which later runs handle. If a tag already exists on origin at tag-creation time, the run blocks loudly pre-publish with nothing public, and the gated publisher/release jobs assert checkout HEAD and tag SHA both equal release_sha.
