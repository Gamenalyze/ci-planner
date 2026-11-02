# Contributing — 0.2.1

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

### GitHub Marketplace publishing

Publish the Action from a tested public release. The root action.yml supplies the listing name, description and branding; README.md supplies the product guide. The software remains free under MIT. Marketplace publication does not certify the code or change runner charges.

1. Merge the release PR after review and passing Node 22/24 CI, including the shipped Action and package smoke test.
2. Draft a release at the exact tested main commit. For this patch, use tag v0.2.1 and title CI Planner v0.2.1. Copy the matching CHANGELOG.md entry into the release body.
3. Select Publish this Action to the GitHub Marketplace. An organization owner must accept GitHub's Marketplace Developer Agreement if GitHub requests it; complete any sign-in or two-factor check in GitHub.
4. Confirm that GitHub accepts the unique Action name. Choose Continuous integration as the primary category and Code quality as the secondary category when offered. Resolve any metadata errors before publishing.
5. Publish the release, open the resulting Marketplace page, and verify that its installation instructions point to this repository and version. Record the actual listing URL only after it exists.

The GitHub release API and publishing a tag alone do not select Marketplace publication. Use the release form's Marketplace option. Do not claim a listing is live based only on a successful CI run or an existing release.

See GitHub's [Marketplace publishing guide](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
