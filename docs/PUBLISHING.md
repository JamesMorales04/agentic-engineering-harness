# Publishing Agentic Engineering Harness to npm

The package name is `agentic-engineering-harness` and the public CLI commands are `aeh` and `engineering-harness`.

The repository is prepared for npm Trusted Publishing through GitHub Actions OIDC. No long-lived npm publish token is stored in the repository workflow.

## Preflight

Before any publication:

```bash
npm run release:check
```

This must pass typecheck, tests, build and `npm pack --dry-run`.

Check whether the desired package name already exists:

```bash
npm view agentic-engineering-harness version
```

An npm `E404` means the name is not currently published. If another owner controls the name, choose a scoped package name before publishing rather than changing package identity after adoption.

## One-time first publication

npm Trusted Publisher configuration requires an npm package to exist first. The first release therefore needs one deliberate maintainer-authenticated publish.

From a clean checkout of the exact release commit:

```bash
npm login
npm run release:check
npm publish --access public
```

Complete the npm account's required 2FA/interactive authentication. Do not create a persistent automation token solely for this bootstrap.

After the first package exists, open the package settings on npmjs.com and configure a Trusted Publisher with:

```text
Provider: GitHub Actions
Organization/user: JamesMorales04
Repository: agentic-engineering-harness
Workflow filename: publish.yml
Allowed action: npm publish
```

The workflow file lives at `.github/workflows/publish.yml`; npm expects only the filename in the Trusted Publisher configuration.

For the strongest steady-state posture, after the OIDC flow has been proven once, disallow traditional publish tokens for the package and retain 2FA on the maintainer account.

## Steady-state release

1. Change `package.json` to the intended semantic version.
2. Ensure the CLI dispatcher reports the same version.
3. Merge only after CI `release:check` passes.
4. Create/publish a GitHub Release tagged exactly:

```text
v<package.json version>
```

For example:

```text
v0.4.16
```

5. The `publish-npm` workflow will:
   - check out the release commit;
   - use Node 24 on a GitHub-hosted runner;
   - verify that the release tag exactly matches `package.json`;
   - run `npm run release:check` again;
   - execute `npm publish` using npm Trusted Publishing/OIDC.

If the tag/version check fails, no publish is attempted.

## What enters the npm tarball

The `files` allowlist in `package.json` publishes only:

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

This is why CI runs `npm pack --dry-run`: bootstrap templates, default agents, skills and toolchain schemas are runtime assets for `aeh init`, not merely repository documentation.

## Consumer installation

Normal projects should pin AEH as a development dependency:

```bash
npm install --save-dev agentic-engineering-harness
npm exec aeh -- init --setup
```

AEH should not be imported into the product runtime merely to use the engineering workflow.

## Failure policy

Publication is a delivery operation, not an engineering-quality gate. A registry/OIDC/permission failure must not cause the source commit to be rewritten or force-pushed. Fix the external publishing configuration and re-run/recreate the release process as appropriate while preserving the already-validated source commit.
