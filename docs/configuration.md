# Input policy reference — 0.1.0

Place `.ci-planner.json` in the repository being analyzed. The planner reads its committed version from the supplied trusted base. A PR cannot use its own changed policy to enable skips.

```json
{
  "schemaVersion": 1,
  "mode": "shadow",
  "globals": ["build/**"],
  "ignored": ["README.md", "docs/**"],
  "jobs": {
    ".github/workflows/ci.yml#test": {
      "inputsComplete": true,
      "inputs": ["src/**", "test/**"]
    }
  }
}
```

A machine-readable [JSON Schema](../policy.schema.json) and [example](../examples/policy.json) ship with the product. The runtime applies its own validation; an editor schema is not the trust boundary.

## Fields

| Field          | Contract                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| schemaVersion  | Must equal 1.                                                                                                                        |
| mode           | shadow or enforce. Start with shadow.                                                                                                |
| globals        | Optional extra file patterns that retain every job.                                                                                  |
| ignored        | Optional patterns that the owner declares unrelated to all checks, unless also matched by a job's inputs.                            |
| jobs           | Map from workflow path#job ID to an input contract.                                                                                  |
| inputsComplete | Explicit owner assertion. If false, the job always runs.                                                                             |
| inputs         | Nonempty list of all file inputs relevant to that job, including tests, scripts, shared libraries, config, fixtures and local tools. |

Unknown policy fields and unsupported patterns are errors. Job IDs must follow GitHub's identifier syntax. A job without a contract runs, including newly discovered jobs.

`inputsComplete: true` does not prove that the list is complete. A maintainer must review transitive code imports, invoked scripts, data files and external inputs. If you cannot bound these, leave the job unscoped. Keep release, security and hidden-state checks fresh.

`ignored` is a strong assertion. Avoid broad declarations such as **; they could hide new code. An input matched by both ignored and a job contract still retains that job.

## Patterns

Paths are relative to the repository root and use /. Supported syntax:

| Pattern        | Matches                                                            |
| -------------- | ------------------------------------------------------------------ |
| src/file.js    | One exact path.                                                    |
| src/*.js       | JavaScript files directly under src.                               |
| src/**         | All paths below src.                                               |
| src/**/file.js | That filename at any depth below src, including directly below it. |

There are no negative patterns, braces, character classes, question marks, parent directory paths or backslash separators. A double star must occupy a whole path segment.

## Mandatory shared inputs

The owner can add global patterns but cannot remove these defaults:

- .github/** and .ci-planner.json
- package.json, package-lock.json, npm-shrinkwrap.json
- yarn.lock, pnpm-lock.yaml, pnpm-workspace.yaml
- .npmrc, .nvmrc, tsconfig*.json
- Dockerfile and Dockerfile.*

Unknown changed paths retain every job. Deletions, renames represented as deletion/addition, unsupported statuses and empty deltas also retain every job.

## Execution dependencies

If a selected job needs another job, its producers run, recursively. Local action/reusable workflow reference paths are implicit inputs, in addition to declared inputs. Changes under .github already trigger full validation.

The following prevent a job from being skipped:

- incomplete or absent input contract;
- unpinned or dynamic action/reusable workflow reference;
- mutable container or service image;
- secrets, vars, inputs or GitHub context expressions;
- an environment or inherited/passed secrets.

Other external state may exist. Detection of common hidden inputs is conservative help, not a complete shell or program analysis.

## Enable enforcement

1. Start with mode shadow and collect plans while existing checks run.
2. Review complete input ownership and compare suggested skips with full results.
3. Merge mode enforce into the target branch through normal review.
4. Enable the Action's enforce input or CLI --enforce.
5. Supply the exact tested base/head merge and retain run-all fallback.

Non-PR events, missing opt-in or missing merge proof remain shadow. Use --force and scheduled full validation to exercise the full CI contract. This tool does not bypass coverage, signing, privacy, release or required-check rules.
