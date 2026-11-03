# Guided setup and draft fix PRs — 0.3.0

These commands make adoption and supported repairs reviewable. They do not infer complete source dependencies, enable enforcement automatically, replace CI, or compile native apps on hosted runners.

## Preview setup

Run from an installed package, or substitute node bin/ci-planner.mjs when using a clone:

    ci-planner init --root /path/to/repo --format markdown

The preview reads committed Git objects and discovers the existing workflow/job graph. It proposes:

1. A .ci-planner.json policy when the repository has none. Its mode is shadow, every job has inputsComplete: false, and broad inputs require owner review.
2. A new .github/workflows/ci-planner.yml advisory PR workflow. It checks out the source, runs CI Planner without write permissions, and shows a plan plus completeness audit in the job summary.

The new workflow has continue-on-error enabled. It neither replaces existing checks nor adds skip conditions to them. It can produce useful missing-check evidence before the owner completes input contracts. Optimization suggestions remain conservative until those contracts are reviewed.

An existing policy is preserved byte-for-byte, including any existing mode and owner assertions. The new advisory Action invocation explicitly requests shadow mode. Existing workflows, runner labels and release gates are not edited.

## Write setup files

    ci-planner init --root /path/to/repo --write
    git -C /path/to/repo diff -- .ci-planner.json .github/workflows/ci-planner.yml

Writing requires a clean checkout at the repository root. Commit or stash existing changes first. Files are created exclusively; existing targets, symlinked parents and unsupported workflow graphs are refused. The command never installs dependencies, executes repository scripts, commits, pushes, opens a PR or starts CI.

The default generated Action ref matches the engine's version. Before that version is released, or to pin production use, supply --action-ref with a reviewed full commit SHA. A complete vMAJOR.MINOR.PATCH tag is also accepted. Mutable branch names and floating major tags are refused by this generator.

Review the advisory runner label. Add the files through your normal PR process. When ready to evaluate job selection, use the [configuration reference](configuration.md) and [integration contract](github-actions.md) to define complete inputs and add run-all fallback conditions to existing jobs. A head policy cannot enable its own skips.

## Preview supported repairs

    ci-planner fix --root /path/to/repo --format markdown

This is read-only and offline. The preview uses the same supported additive check generator as audit-repo --add-checks, but does not write its proposed file. JSON output includes its proposed contents, added check IDs, omitted checks and before/after static audit counts.

The first supported fixes are existing direct Node test/lint/type/format commands with an npm lockfile, dependency auditing, repository secret scanning and workflow lint. Conditional or unverified findings, arbitrary wrappers, missing test suites and native/container/build placement remain for manual review. The generator does not invent meaningful tests or remove existing checks.

## Open a draft fix PR

Use an authenticated GitHub CLI from a trusted local checkout:

    ci-planner fix --root /path/to/repo --repository OWNER/REPO --open-pr

This explicit flag authorizes remote writes and may trigger the repository's normal PR workflows. The CLI identity needs permission to create repository branches, add workflow files and open pull requests. It requires no CI Planner account or model service.

Publication is local-only in this release: GitHub Actions and PR event contexts are refused. The normal CI Planner Action remains read-only. Do not run privileged analysis on untrusted PR source.

Before publishing, the command:

1. Regenerates the proposal from committed local objects.
2. Requires local HEAD to match the remote repository's default branch.
3. Validates the generated YAML, unprivileged PR event and additive workflow contract.
4. Refuses an existing generated file, tracked descendant or leaf ancestor at that path, and an existing deterministic fix branch. A directory cannot be replaced by the proposed workflow.
5. Builds a new commit adding only .github/workflows/ci-planner-checks.yml.
6. Checks that the default branch has not moved, creates a new branch and opens a draft PR.

No existing ref, workflow, policy, release rule or local file is updated. Concurrent publishers target the same branch name; one wins and the other stops instead of opening a duplicate PR. A changed base requires a fresh audit.

The PR explains the missing invocations, proposed checks, omissions, static validation and rollback. It does not claim that tests ran or that CI passed. Review its commands, dependency installation, runner choice and required-check behavior before marking it ready or merging.

If there are no supported missing checks, publication is a no-op and needs no API calls. If PR creation is not confirmed after branch creation, the error identifies the branch for inspection. The tool leaves it intact because the PR may already exist after a partial response. It never deletes branches to hide an uncertain operation.

Rollback removes only the generated workflow. The original CI remains intact.

## API and tests

- @gamenalyze/ci-planner/setup exports proposeSetup for pure snapshot previews and initializeRepository for Git-backed previews or explicit local writes.
- @gamenalyze/ci-planner/fix-pr exports previewFix, openFixPullRequest and fixPullRequestBody. The publisher accepts an injectable GET/POST transport so tests need no live account or write token.
- Public functions and trust boundaries carry source annotations. Tests cover dirty state, policy preservation, symlink refusal, graph errors, source isolation, base drift, concurrent publication and partial API responses.

In 0.4.0, init proposes source and script directories found in the committed inventory, package/config files, and common documentation ignores. Documentation explicitly referenced by package scripts, or included through npm pack, is kept as suggested input too. Proposals remain broad: all jobs share the conservative discovered scope and every inputsComplete stays false. Review transitive imports, fixtures, generated/runtime inputs and the proposed ignores before narrowing each job. This is an onboarding draft, not proof of complete ownership.
