# Automatic publishing — 0.4.0

Merging a reviewed version bump and dated changelog section into main starts normal CI. After the two Node validation lanes succeed, Publish CI Planner creates the stable GitHub release at that exact commit, with the npm tarball and its SHA-256 checksum. Ordinary commits with an already-published version do not create another release. A version tag is never moved or overwritten.

The publisher checks repository identity, default branch, successful push event, source SHA, expected CI job names and conclusions, package/engine version agreement, and the current main tip. It rejects stale runs and conflicting tags. The write-capable job only checks out a successful canonical main push (or its exact published version tag for a manual recovery); it never uses PR artifacts or PR workflow-run source. Dependency installation disables lifecycle scripts. The publishing workflow uses the repository GITHUB_TOKEN and needs no extra release secret.

GitHub's public Marketplace latest-release metadata is checked after publication. A release existing on GitHub does not by itself count as a verified Marketplace update. If the index is unavailable, stale or GitHub requests browser confirmation, the workflow fails with a direct release-edit link. This preserves the already-created release and version tag. An owner may complete GitHub's required Publish this Action to the GitHub Marketplace UI step, then rerun Publish CI Planner with workflow_dispatch and that successful main CI run ID. Never store browser sessions or personal tokens to bypass this step.

GitHub documents a Marketplace checkbox and two-factor confirmation, and exposes no documented Marketplace publish parameter in its REST create-release endpoint. The workflow therefore attempts normal release publication and verifies the outcome instead of inventing an API flag. See [GitHub publishing requirements](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace) and [the release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

## npm trusted publishing

The free npm organization gamenalyze is owned by the authenticated gameanalyze account. The npm channel is @gamenalyze/ci-planner. It is separate from the GitHub Marketplace Action.

The publisher's npm job is enabled only after the first authenticated package publication and an npm trusted-publisher configuration exist. That configuration binds @gamenalyze/ci-planner to Gamenalyze/ci-planner, workflow release.yml and environment npm-release, with direct publishing permitted. The GitHub environment restricts deployments to main and v* tags before any checkout/OIDC access; other branches cannot enter the npm job. Set the repository variable NPM_PUBLISH_ENABLED=true only after checking it. Account 2FA and first-publish browser authorization must be completed by the owner. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Once enabled, successful GitHub publication runs the separate npm job with contents: read and id-token: write. It uses npm 11.17.0 and OIDC; no persistent npm token is saved in GitHub. It verifies canonical source/branch identity and the release tag, downloads the release tarball and SHA-256 checksum, verifies its bytes, publishes with provenance, then verifies the registry's SHA-512 integrity matches that same tarball. Retry skips immutable already-published bytes, while a checksum/integrity mismatch fails. Commits without version bumps never republish. Missing trusted publishing or npm/Marketplace verification produces a visible failure.

The install command after the first verified publication is `npx @gamenalyze/ci-planner audit --repository OWNER/REPO --format markdown`. The GitHub tarball installation remains available independently of npm registry access.


If main has advanced before recovery, dispatch Publish CI Planner at the existing version tag (for example v0.4.0) with its successful main CI run ID, rather than running newer main source. Both channels independently verify that exact CI head and both Node lanes, that the version tag matches the package, and that its commit is an ancestor of main. The npm job may run after a Marketplace-only failure; it independently rechecks CI, release and bytes and cannot publish after an invalid source or failed CI. This keeps npm independent of a delayed Marketplace index without misattributing old package bytes to a newer source commit.


Registry verification reads the exact version over HTTPS with a unique verification query and no-cache/no-store hints, a 20-second timeout and a 4 MiB response bound. This avoids stale negative packument caches observed during the first automatic npm publication. HTTP 404 remains an unverified/not-yet-visible record; other read failures and malformed/oversized records fail visibly. The published SHA-512 must still equal the verified release tarball, including on retry.
