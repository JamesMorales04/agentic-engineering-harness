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
7. commits the version metadata as `chore(release): vX.Y.Z [skip ci]` and creates the matching Git tag;
8. publishes the package to npm;
9. creates the GitHub Release for the tag.

The release commit/tag is pushed with GitHub's repository token. GitHub does not recursively trigger ordinary push workflows for pushes created with that `GITHUB_TOKEN`, so the version commit does not create an infinite publish loop.

## Manual release control

`publish-npm` also supports `workflow_dispatch`. The `bump` input can be:

```text
auto     # Conventional Commit-derived bump
current  # publish current version only if it is not already published
patch
minor
major
```

Manual dispatch is useful for retrying an external npm/OIDC failure or deliberately overriding the automatic bump classification.

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

The repository currently starts this release line at `0.6.1`. After that, normal merges do not require a human to edit the version manually. The release workflow owns the release metadata bump.

If a PR intentionally changes the package version to a version that is not yet on npm, that repository version wins: the next `main` publication ships it before any further automatic increment. This makes explicit release corrections and recovery deterministic.

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

Packaged `skills/` and core `policies/` are runtime control-plane assets. `aeh init`, `aeh setup`, and `aeh start` reconcile those package assets into the consumer repository's `.harness` directory. `.harness/managed-assets.json` records hashes so missing or untouched files can be restored/upgraded without overwriting project-local modifications.

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

A registry/OIDC/permission failure is an external delivery failure, not a reason to rewrite validated engineering history. The release workflow is retry-safe: if the version commit/tag exists but npm publication failed, a manual rerun with `current` will attempt the same unpublished version rather than incrementing it again.
