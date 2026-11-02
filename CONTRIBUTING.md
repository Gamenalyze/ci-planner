# Contributing — 0.1.0

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

Keep changes small and reviewable. CI runs syntax checks, tests, documentation link checks and a package smoke test in one job. A maintainer reviews changes to policy semantics, Action outputs and dependencies before release.

Use semantic versions. Keep package.json, package-lock.json, the exported engine version and CHANGELOG.md aligned. Tag only a tested commit. Production users should pin Actions to a reviewed SHA rather than relying on a mutable tag.
