# CI Planner

Free CI audits and conservative pull request plans for GitHub Actions. Version 0.2.0.

CI Planner helps you see where CI time goes and decide which jobs a PR needs. It rebuilds its job graph from committed workflows on each plan. It runs locally or on your runners. No account, model API key, paid tier or hosted service is required.

**This is an early release. Start in shadow mode.** Skipping depends on owner-declared input contracts. This release does not infer every code dependency or reuse results across runs.

## What works today

- Audit recent Actions runs, including parallel workers, cancelled work and early failures.
- Save a small metadata snapshot and replay the audit offline.
- Discover new workflows, jobs and local job dependencies without a filename registry.
- Produce a JSON plan bound to the base, head and optional tested merge commit.
- Explain each run or suggested skip; keep required producers when a consumer runs.
- Gate jobs through the included Action after an owner enables enforcement.

Unknown inputs, structural changes, shared runtime/control changes, new jobs, hidden inputs and mutable action references keep validation fresh. An invalid or unavailable planner must make the workflow run its existing checks.

## Install

Requires Node.js 22 or newer and Git. Live audits also need an installed, authenticated [GitHub CLI](https://cli.github.com/). CI tests Node.js 22 and 24; the Action sets up Node.js 24.

```sh
git clone https://github.com/Gamenalyze/ci-planner.git
cd ci-planner
npm ci --ignore-scripts
node bin/ci-planner.mjs --help
npm test
```

After installing the package locally, its executable is named `ci-planner`. The package is not yet published to npm; the clone commands above work now.

## Audit CI

```sh
node bin/ci-planner.mjs audit --repository OWNER/REPO --workflow ci.yml --limit 20
node bin/ci-planner.mjs audit --repository OWNER/REPO --snapshot > snapshot.json
node bin/ci-planner.mjs audit --input snapshot.json
```

The collector reads run/job metadata using GET requests. It does not fetch logs, artifacts, source code or secret values. The audit sums observed worker time, which differs from elapsed workflow time and billed minutes. Findings are review prompts; savings and billing values remain null.

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
- [Complete example workflow](examples/pull-request.yml) and [example input policy](examples/policy.json)

The [repository completeness audit](docs/repository-audit.md) finds missing or uncertain PR checks from source/config evidence. Run `node bin/ci-planner.mjs audit-repo --root /path/to/source`. It never edits CI by itself.

Public APIs and safety decisions have JSDoc and inline annotations in [the source](src/).

## Scope and cost

The software is free under the [MIT license](LICENSE), for public and private repositories. Your existing runner, storage and network charges still apply. There is no required paid AI service.

This version supports GitHub Actions workflow/job discovery and explicit file input contracts. It does not yet provide automatic source dependency inference, optimization PRs, cross-run reuse, shard balancing or a hosted GitHub App. Timing history never grants permission to skip a job.

It does not change release rules, coverage floors, signing rules, runner placement or branch protection. Native app compilation can remain on internal runners while source checks use other runners.
