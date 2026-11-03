# Contributing — 0.3.0

Contributions are welcome. The core engine, adapter and docs remain free under MIT.

## Local setup

Use Node.js 22+ and Git:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests create small Git fixtures in the system temporary directory. Set TMPDIR to a suitable working volume when needed. No test needs production credentials, a model API, a live GitHub repository or a hosted runner.

For a local package smoke test, run npm pack and install its tarball into an empty temporary project with lifecycle scripts disabled. Do not publish to npm as part of routine validation.

## Changes

Open an issue with a task description. A bug report should include the bug, scenario, expected behavior and a small redacted reproduction. Link the implementation branch and PR. Keep private repository names, snapshots, logs and credentials out of public issues.

Add a focused regression test for a selection or trust-boundary change. Include the failing case and why it must run or may skip. Keep docs and JSDoc aligned with behavior. Update CHANGELOG.md for user-visible changes.

Never weaken coverage, required checks or input completeness to make a demo appear cheaper. Unknown evidence must keep checks fresh. Do not execute PR code during privileged analysis, accept head-controlled policies as trusted, or turn timing history into skip authority.

## Review and releases

Keep changes small and reviewable. CI runs syntax checks, tests, documentation link checks and a package smoke test on Node.js 22 and 24. A maintainer reviews changes to policy semantics, Action outputs and dependencies before release.

Use semantic versions. Keep package.json, package-lock.json, the exported engine version and CHANGELOG.md aligned. Tag only a tested commit. Production users should pin Actions to a reviewed SHA rather than relying on a mutable tag.

### Automatic GitHub, Marketplace and npm publication

Merge a reviewed version bump with a dated changelog section and passing Node 22/24 CI. After successful main push CI, Publish CI Planner creates the release at the tested commit, attaches the npm tarball and checksum, and verifies the public Marketplace version. The separate npm job publishes identical verified bytes through OIDC once the package's trusted publisher is configured. No persistent npm token belongs in GitHub.

The npm-release GitHub environment must restrict deployments to main and version tags, and the npm trusted publisher must bind this repository, release.yml and npm-release with publish permission. Enable NPM_PUBLISH_ENABLED only after verifying that configuration. Ordinary commits without version bumps do not create another release, and version tags never move.

A failed Marketplace check does not prove publication. Inspect its direct release-edit link if GitHub requests UI/2FA confirmation. For recovery after main advances, dispatch the workflow at the matching released version tag and supply its successful main CI run ID. Both publication channels independently verify CI, commit and release identity. See [the full publishing contract](docs/publishing.md).

The software remains free under MIT. A Marketplace listing does not certify the code or change runner charges. GitHub documents its [Marketplace publishing requirements](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
