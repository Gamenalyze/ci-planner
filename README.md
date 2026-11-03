# CI Planner

Free CI waste and missing-check audits for GitHub Actions, with a conservative planner. Version 0.4.1.

Start with zero-config, read-only audits: see the share of worker time spent in cancelled runs, median and p90 job durations, and missing PR checks. Then evaluate conservative job selection in shadow mode. It rebuilds its job graph from committed workflows on each plan. It runs locally or on your runners. No account, model API key, paid tier or hosted service is required.

**Upgrade before enforcing skips:** v0.3.0 and earlier can miss changed submodule inputs under Git ignore settings. Keep enforce disabled until using the reviewed v0.3.1 fix. See [security details](SECURITY.md).

**This is an early release. Start in shadow mode.** Skipping depends on owner-declared input contracts. Dependency discovery suggests JS/TS scopes for owner review. Cross-run reuse requires a signed full-run attestation, whole-tree equivalence and an explicit owner runtime contract.

## What works today

- Audit recent Actions runs, including parallel workers, cancelled work and early failures.
- Save a small metadata snapshot and replay the audit offline.
- Discover new workflows, jobs and local job dependencies without a filename registry.
- Produce a JSON plan bound to the base, head and optional tested merge commit.
- Explain each run or suggested skip; keep required producers when a consumer runs.
- Gate jobs through the included Action after an owner enables enforcement.
- Read plan, audit and setup reports in Markdown or a GitHub job summary.
- Preview advisory setup files with init, and write them only on request.
- Preview supported missing-check fixes and explicitly publish them as draft PRs.
- Compare skip suggestions with full runs and force fresh validation on unsafe feedback.
- Discover JS/TS workspace dependencies, literal imports and TypeScript project references.
- Verify signed PR-to-main reuse evidence against the complete tree, runtime contract and live latest run.
- Review uneven shards, repeated installs, cache evidence and late-finishing jobs.

Unknown inputs, structural changes, shared runtime/control changes, new jobs, hidden inputs and mutable action references keep validation fresh. An invalid or unavailable planner must make the workflow run its existing checks.

## Install

For GitHub Actions, use the full reviewed commit SHA from the v0.4.1 release with the [complete workflow example](examples/pull-request.yml). Tags remain mutable. An owner may explicitly allow a publisher and record a base-owned expected Action SHA; unresolved, unpinned or moved tags retain the job. Start in shadow mode and keep the run-all fallback. For production, pin the Action to the reviewed release commit SHA. The Action runs on your runner; it needs no CI Planner account, API key or hosted service.

Requires Node.js 22 or newer and Git. Live audits also need an installed, authenticated [GitHub CLI](https://cli.github.com/). CI tests Node.js 22 and 24; the Action preserves an existing Node.js 22+ runtime and installs Node.js 24 only when needed.

```sh
git clone https://github.com/Gamenalyze/ci-planner.git
cd ci-planner
npm ci --ignore-scripts
node bin/ci-planner.mjs --help
npm test
```

After installing the package locally, its executable is named `ci-planner`. Stable releases also attach an installable npm tarball and SHA-256 checksum. For a one-command audit without cloning, use:

```sh
npx --yes --package=https://github.com/Gamenalyze/ci-planner/releases/download/v0.4.1/gamenalyze-ci-planner-0.4.1.tgz ci-planner audit --repository OWNER/REPO --format markdown
```

The npm package can also be installed with `npx @gamenalyze/ci-planner audit --repository OWNER/REPO --format markdown`. See [publishing](docs/publishing.md) for automatic GitHub, Marketplace and npm publication.

## Audit CI

For guided adoption, start with these offline previews:

    node bin/ci-planner.mjs init --root /path/to/source --format markdown
    node bin/ci-planner.mjs fix --root /path/to/source --format markdown

Setup creates files only with --write; existing policies and workflows are preserved. New input contracts are incomplete and shadow-only until owner review. To open a supported fix as a draft PR, run fix --repository OWNER/REPO --open-pr from a trusted local checkout matching the remote default branch. That explicit operation may start normal repository CI. See [guided setup and fix PRs](docs/onboarding-and-fixes.md).

```sh
node bin/ci-planner.mjs audit --repository OWNER/REPO --workflow ci.yml --limit 20
node bin/ci-planner.mjs audit --repository OWNER/REPO --snapshot > snapshot.json
node bin/ci-planner.mjs audit --input snapshot.json
```

The collector reads run/job metadata using GET requests. It does not fetch logs, artifacts, source code or secret values. The audit sums observed worker time, which differs from elapsed workflow time and billed minutes. The report sums worker time by run conclusion and shows the cancelled share. Cancellation cause stays unknown until investigated; a superseded-push pattern may justify a 30–60 second debounce or cheap first gate. Savings and billing values remain null. Optional owner-supplied runner rates produce clearly labeled, coverage-aware cost estimates.

## Plan a PR

Run the tool from its clone and point `--root` at a fetched source repository:

```sh
node bin/ci-planner.mjs plan --root /path/to/source --repository OWNER/REPO --base BASE_SHA --head HEAD_SHA
```

Use full commit SHAs. The default is shadow mode: all `run` values are true while `candidate` explains suggested skips. Policy is read from the base commit, never from dirty files or the PR's changed policy.

To enable skips, commit an input policy to the target branch, request `--enforce`, and supply `--merge MERGE_SHA`. The merge must have the exact base and head as its first two parents. Read the [configuration reference](docs/configuration.md) and [Action guide](docs/github-actions.md) before doing this.

## Documentation

- [Setup, commands, output and troubleshooting](docs/cli.md)
- [Input policy and JSON Schema](docs/configuration.md)
- [GitHub Actions integration and run-all fallback](docs/github-actions.md)
- [Architecture, adaptation and API reference](docs/architecture.md)
- [Security and trust boundaries](SECURITY.md)
- [Contributing and validation](CONTRIBUTING.md)
- [Release notes](CHANGELOG.md)
- [Readable reports and GitHub job summaries](docs/reports.md)
- [Guided setup and draft fix PRs](docs/onboarding-and-fixes.md)
- [Skip validation, dependency discovery, signed reuse and performance advice](docs/evidence-and-performance.md)
- [Complete example workflow](examples/pull-request.yml) and [example input policy](examples/policy.json)

The [repository completeness audit](docs/repository-audit.md) finds missing or uncertain PR checks from source/config evidence. Run `node bin/ci-planner.mjs audit-repo --root /path/to/source`. It never edits CI by itself.

Public APIs and safety decisions have JSDoc and inline annotations in [the source](src/).

## Scope and cost

The software is free under the [MIT license](LICENSE), for public and private repositories. Your existing runner, storage and network charges still apply. There is no required paid AI service.

This version supports GitHub Actions workflow/job discovery, explicit file input contracts and additive draft PRs for supported missing checks. It provides advisory JS/TS dependency discovery and timing advice, plus separately enabled signed PR-to-main reuse. It does not automatically balance shards, rewrite existing optimization policy or provide a hosted GitHub App. Timing history never grants permission to skip a job.

It does not change release rules, coverage floors, signing rules, runner placement or branch protection. Native app compilation can remain on internal runners while source checks use other runners.
