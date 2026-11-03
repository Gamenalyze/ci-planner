# CLI reference — 0.3.0

## Setup

Install Node.js 22+ and Git, clone the public repository, then run `npm ci --ignore-scripts`. Run `node bin/ci-planner.mjs` from that clone. All examples below use the installed executable name `ci-planner`; substitute the Node command when using a clone.

No global install or npm publication is needed. To test the installable package, run `npm pack`, then install the resulting tarball into a separate directory with `npm install --ignore-scripts /path/to/tarball`. This is a local install, not publication.

## Audit

```text
ci-planner audit --repository OWNER/REPO [--workflow ci.yml] [--branch main] [--limit 20] [--snapshot]
ci-planner audit --input snapshot.json
```

| Option       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| --repository | GitHub owner/repository. Required for live collection.            |
| --workflow   | Optional workflow filename, such as ci.yml.                       |
| --branch     | Optional exact branch filter, encoded as a query value.           |
| --limit      | 1–20 recent runs; default 20.                                     |
| --snapshot   | Emit replayable metadata instead of an audit. Live mode only.     |
| --input      | Read one snapshot up to 32 MiB. Cannot combine with live options. |

Live collection uses installed `gh` authentication and Actions read access. It reads up to five pages of 100 jobs for the exact listed attempt of each run. Earlier attempts and older runs are excluded. A changing inventory refuses collection; retry after the run completes.

The versioned snapshot contains repository, selection, selected run fields and selected job fields. Bounded step name/status/timestamp metadata is retained for performance advice. Logs, step outputs, artifact payloads and runner identities are omitted. A snapshot can still reveal private repository and job names; store it within your own access controls.

The audit reports totals, per-run observations, findings and limitations. `complete` means that this observed run attempt has all listed jobs and valid timing or skipped status; it does not mean that all repository history was collected.

- Concurrent job durations add together.
- Skipped jobs add zero.
- Missing or unfinished times make the observation partial.
- Work after the first failed job clips each worker interval at that failure time.
- Duplicate run/job IDs and mismatched attempts are rejected.
- `billingMinutes` and `estimatedSavingsSeconds` remain null.

A cancellation can be useful. A repeated same-head success can have a different merge tree, environment or purpose. Neither establishes waste or reusable evidence.

## Plan

```text
ci-planner plan --base SHA --head SHA [--merge SHA] [--root DIR]
  [--repository OWNER/REPO] [--event pull_request]
  [--workflow .github/workflows/ci.yml] [--enforce] [--force] [--github-output]
```

| Option          | Meaning                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| --base          | Available full trusted base commit SHA.                                                                    |
| --head          | Available full PR head SHA.                                                                                |
| --merge         | Optional tested merge, with exact base/head parents. Required for enforcement.                             |
| --root          | Source checkout directory; default current directory.                                                      |
| --repository    | Repository identity; default local.                                                                        |
| --event         | Event type; defaults to GITHUB_EVENT_NAME or pull_request for local review. Only pull_request can enforce. |
| --workflow      | Filter exported job booleans to one workflow path; the full JSON plan still covers all workflows.          |
| --enforce       | Request skips, subject to trusted base-policy opt-in and verified merge.                                   |
| --force         | Keep every job; use for periodic or manual full validation.                                                |
| --github-output | Append Action outputs to GITHUB_OUTPUT only after a valid plan. Requires --workflow.                       |

Planning reads committed objects, not working tree content. Without merge it compares merge-base..head for shadow review. With merge it compares base..merge, including changes introduced when combining branches. Fetch all required commits before planning.

The JSON plan has schema/engine versions, source identity, policy source/hash, plan hash, full-validation reasons, limitations and a job map. Keys use `.github/workflows/file.yml#job_id`. Each job has:

| Field         | Meaning                                        |
| ------------- | ---------------------------------------------- |
| workflow / id | Discovered workflow path and job identifier.   |
| candidate     | run or skip suggestion.                        |
| reason        | Stable reason for that suggestion.             |
| run           | Actual gate value. Always true in shadow mode. |

The plan hash binds the engine version, source identities, normalized base policy, workflow sources, complete change list, force/validation-fallback flags and enforcement mode. It is a digest, not a signature or cross-run proof. Do not accept a plan supplied by PR text or an untrusted artifact as authority.

Action outputs are `run` (job-ID boolean map), `ready=true`, `mode`, and `plan_hash`. The composite Action exposes `plan-hash` for its digest. If generation fails, it exports no ready flag. Gate consumers must run on missing outputs.

## Exit codes and limits

All result commands accept --format json|markdown and --summary. Existing commands keep JSON by default. --summary appends to GITHUB_STEP_SUMMARY and keeps stdout in its requested format. The report command defaults to Markdown. It reads one JSON result up to 4 MiB; see [readable reports](reports.md) for escaping, truncation and interpretation limits.

New owner-invoked commands:

    ci-planner init [--root DIR] [--action-ref FULL_SHA|vMAJOR.MINOR.PATCH] [--write]
    ci-planner fix [--root DIR] [--repository OWNER/REPO --open-pr]
    ci-planner report --input report.json

init previews advisory setup by default. --write exclusively creates missing setup files in a clean checkout. fix previews an additive workflow by default. --open-pr explicitly creates a new branch and draft PR from the matching remote default branch; it is local-only and may start normal PR CI. Read [setup and fix boundaries](onboarding-and-fixes.md) before using either write operation.

plan also accepts --audit-repo to attach static completeness evidence from the exact tested commit. An unavailable optional audit records a warning and does not change decisions or the plan hash.

Exit 0 means the command produced a valid result. Exit 1 means invalid arguments, inaccessible evidence, unsupported inputs or a failed read. Missing evidence does not produce an empty skip map.

Planning supports at most 20,000 tracked files, 100 workflow definitions, 1,000 jobs, 256 KiB per workflow, 64 KiB base policy, and 200 patterns per pattern list. Git reads and gh calls have per-call timeouts. Live audit collection is sequential and may take longer than one API call.

## Evidence and performance commands

Use validate for shadow/full-run feedback, discover for JS/TS workspace scope suggestions, advise for timing advice, attest in a separate trusted coordinator, and reuse for signed PR-to-main verification. See [input formats, trust boundaries and fallback integration](evidence-and-performance.md). All accept the standard JSON/Markdown and summary presentation options. Signing is explicit; the ordinary planner still runs on push.

## Troubleshooting

- **GitHub metadata read failed:** ensure gh is on PATH, authenticated and allowed to read Actions.
- **Unavailable SHA:** fetch base, head and tested merge; shallow histories often omit them.
- **Merge identity mismatch:** use the synthetic PR merge whose parents match the supplied base and head. Do not substitute the PR head.
- **Every job runs:** inspect mode and reasons. Unknown paths, new jobs and incomplete contracts are expected conservative outcomes.
- **Unsupported YAML or graph:** run existing checks via fallback; simplify the unsupported syntax or contribute a tested parser extension.
- **No savings value:** this release does not calculate billing or infer avoidable work from timings.

## Audit repository check coverage

Run ci-planner audit-repo --root DIR [--ref HEAD|FULL_SHA]. It prints JSON covering detected checks, invocation locations, uncertainties and recommendations. Exit 0 means a valid report, including reports with missing checks; exit 1 means invalid input or an unreadable/bounded snapshot. Read [the completeness audit guide](repository-audit.md) before acting on findings.

## Historical replay and affected tests

`ci-planner history --repository OWNER/REPO --contract FILE --limit 5 --root . --fetch` collects bounded merged-PR execution observations. The contract must explicitly name the workflow, every matrix display name, and required test steps. Missing evidence remains unknown; replay never grants skip authority.

`ci-planner affected --base SHA --ref HEAD --runner jest` emits a test matrix from static single-package JavaScript imports. Use `vitest` for a Vitest consumer. Unsupported or uncertain inputs run all. The optional `--github-output` exports `matrix`, `run_all` and `ready` only after successful selection. A missing/failed producer must cause a full-suite fallback.

See [the roadmap guide](audit-roadmap.md) and [consumer runner](../examples/run-affected-tests.mjs).
