# Publishing the npm package

[Project home](../README.md) · [简体中文](./releasing.zh-CN.md)

The release target is the public package `@nexusmc-cn/axnexus`. Pushing a `v*` tag triggers the [release workflow](../.github/workflows/release.yml), which verifies, packs, and publishes the commit referenced by that tag. Merging the workflow alone does not publish a package.

Day-to-day development continues to use pnpm: `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm test`, `pnpm run test:types`, `pnpm run test:consumer`, and `pnpm pack`. The `prepack` hook uses npm to invoke the build so that `npm pack` and `npm publish` can also run without a globally installed pnpm. Contributors do not need to switch their development commands to npm.

## Initial setup: configure an npm Trusted Publisher

A package maintainer must add a GitHub Actions Trusted Publisher in the package settings on the npm website. This is a one-time setup on npm; committing repository files does not configure it automatically.

| npm setting | Value |
| --- | --- |
| Organization or user | `NexusMC-CN` |
| Repository | `axnexus` |
| Workflow filename | `release.yml`; enter only the filename |
| Environment name | Leave blank; the current workflow does not use a GitHub environment |
| Allowed actions | Allow `npm publish` |

Allowing only the default `npm stage publish` action is insufficient for this workflow. A newly created Trusted Publisher must complete its first successful publish within 2 days. If it expires, delete it and configure it again. See the [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for the requirements.

The workflow uses a GitHub-hosted Ubuntu runner, Node.js 24, and npm 11, with `contents: read` and `id-token: write` permissions. npm OIDC publishing requires Node.js 22.14.0 or later and npm 11.5.1 or later; upgrades to the release tools must continue to meet these requirements. Publishing uses short-lived OIDC credentials, so no `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed.

To generate provenance, both the repository and the npm package must remain public, and the `repository` field in `package.json` must match the actual repository. The workflow explicitly passes `--provenance`, which publicly links the package to its source commit and workflow run. See the [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements/).

## Prepare a stable release

1. Update the version in `package.json` and the entries in `CHANGELOG.md`, then commit all changes for the release.
2. Use the pnpm version declared in `packageManager` to run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm run test:types`, and `pnpm run test:consumer`.
3. Confirm that regular CI checks pass for the target commit, including browser, Bun, and Nuxt consumer verification. The release workflow separately reruns Node.js tests, type checks, and consumer verification against the actual release tarball.
4. Merge the reviewed release commit into the main branch. Confirm that it includes `release.yml` and that the Trusted Publisher is correctly configured on npm.

This workflow supports only stable versions in strict `X.Y.Z` format, with no leading zeros in any component. The tag must exactly match the package version: for example, version `0.4.0` requires tag `v0.4.0`. Prerelease versions and build metadata are both rejected. Publishing uses npm's default `latest` dist-tag, so this workflow cannot publish prereleases such as `-beta`. Before adding prerelease support, define a separate dist-tag flow for it.

## Create the tag and verify the result

Create a tag on the confirmed release commit and push only that tag. Replace `X.Y.Z` below with the target version from `package.json`:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

The workflow disables dependency caching and installs dependencies with a frozen lockfile. After the tests pass, `pnpm pack --json` runs the normal `prepack` hook and creates a single tarball in an isolated temporary directory. The consumer test accepts this existing tarball, checks its contents, and installs and verifies it in a temporary project. The publish step then passes the same path to `npm publish`, without packing the workspace again.

Inspect the Release run in GitHub Actions and confirm that its final publish step succeeds. Then check the version, the `latest` dist-tag, and the provenance records on npm. You can query the version metadata with:

```bash
npm view @nexusmc-cn/axnexus@X.Y.Z version dist.integrity dist.attestations --json
npm view @nexusmc-cn/axnexus dist-tags --json
```

A successful local pack, consumer test, or `npm publish --dry-run` confirms only the local checks. It does not confirm the npm OIDC identity binding, publishing permissions, or a successful remote publish.

If publishing fails, first use the Actions logs to identify the failing stage. For authentication failures, check the organization, repository, workflow filename, Allowed actions, and initial publishing deadline in the npm configuration. Before rerunning the workflow, query whether the version already exists: npm does not allow a published package name and version combination to be reused. If the version exists, inspect the remote result instead of moving the tag or attempting to overwrite the version. See the [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
