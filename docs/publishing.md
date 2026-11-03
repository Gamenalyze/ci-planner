# Automatic publishing — 0.4.0

Merging a reviewed version bump and dated changelog section into main starts normal CI. After the two Node validation lanes succeed, Publish CI Planner creates the stable GitHub release at that exact commit, with the npm tarball and its SHA-256 checksum. Ordinary commits with an already-published version do not create another release. A version tag is never moved or overwritten.

The publisher checks repository identity, default branch, successful push event, source SHA, expected CI job names and conclusions, package/engine version agreement, and the current main tip. It rejects stale runs and conflicting tags. The write-capable job only checks out a successful canonical main push; it never uses PR artifacts or PR workflow-run source. Dependency installation disables lifecycle scripts. The publishing workflow uses the repository GITHUB_TOKEN and needs no extra release secret.

GitHub's public Marketplace latest-release metadata is checked after publication. A release existing on GitHub does not by itself count as a verified Marketplace update. If the index is unavailable, stale or GitHub requests browser confirmation, the workflow fails with a direct release-edit link. This preserves the already-created release and version tag. An owner may complete GitHub's required Publish this Action to the GitHub Marketplace UI step, then rerun Publish CI Planner with workflow_dispatch and that successful main CI run ID. Never store browser sessions or personal tokens to bypass this step.

GitHub documents a Marketplace checkbox and two-factor confirmation, and exposes no documented Marketplace publish parameter in its REST create-release endpoint. The workflow therefore attempts normal release publication and verifies the outcome instead of inventing an API flag. See [GitHub publishing requirements](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace) and [the release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

## npm registry status

The release tarball is a normal scoped npm package and can be installed directly from its GitHub release URL. Publishing @gamenalyze/ci-planner to registry.npmjs.org is a separate channel. It is not enabled by this workflow: npm account/scope ownership and an authenticated first publication or supported package bootstrap have not been configured here.

For a later npm workflow, use npm trusted publishing bound to this repository, exact workflow filename and an optional protected environment. The workflow needs id-token: write and an npm version supporting OIDC. Verify the package's trusted publisher permits direct publish before enabling it. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). Do not add a long-lived npm token just to make a green release badge.
