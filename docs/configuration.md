# Input policy reference — 0.4.0

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

Patterns also match dotfiles (src/* includes src/.env); file matching does not read secret values. There are no negative patterns, braces, character classes, question marks, parent directory paths or backslash separators. A double star must occupy a whole path segment.

## Mandatory shared inputs

The owner can add global patterns but cannot remove these defaults. Shared manifest/toolchain filenames match at every directory depth, including under ignored docs/**:

- .github/** and .ci-planner.json
- package.json, package-lock.json, npm-shrinkwrap.json
- yarn.lock, pnpm-lock.yaml, pnpm-workspace.yaml
- .npmrc, .nvmrc, tsconfig*.json
- Dockerfile and Dockerfile.*

Unknown changed paths retain every job. Deletions, renames represented as deletion/addition, unsupported statuses and empty deltas also retain every job.

## Execution dependencies

If a selected job needs another job, its producers run, recursively. Local action/reusable workflow reference paths are implicit inputs, in addition to declared inputs. Changes under .github already trigger full validation.

Additional shared inputs include Git attributes/submodules, tool versions, Go/Cargo/Python/Ruby manifests/locks and Compose definitions. The initial list was Node-oriented; it is not a complete list for every build system. Add project-specific shared inputs through globals.

The following prevent a job from being skipped:

- incomplete or absent input contract;
- unpinned, dynamic or unresolved action/reusable workflow reference;
- mutable container or service image;
- secrets, vars, inputs, external env, dynamic context indexing or unmodeled GitHub/runner context expressions;
- an environment or inherited/passed secrets.

Other external state may exist. Detection of common hidden inputs is conservative help, not a complete shell or program analysis.

## Enable enforcement

1. Start with mode shadow and collect plans while existing checks run.
2. Review complete input ownership and compare suggested skips with full results.
3. Merge mode enforce into the target branch through normal review.
4. Enable the Action's enforce input or CLI --enforce.
5. Supply the exact tested base/head merge and retain run-all fallback.

Non-PR events, missing opt-in or missing merge proof remain shadow. Use --force and scheduled full validation to exercise the full CI contract. This tool does not bypass coverage, signing, privacy, release or required-check rules.

## Data and control dependencies

Data dependencies propagate in both directions: selected consumers retain producers, and selected producers invalidate consumers, transitively. Shared dependency inputs no longer need to be copied into each downstream contract.

A job may declare controlNeeds as a list of its needs job IDs when those edges provide ordering or planner gating only. This is a reviewed owner assertion: these edges must not provide runtime data, build artifacts or test inputs. No edge is control-only by default. Invalid edge names are rejected. The example test declares controlNeeds: [plan], so the planner can run without forcing unrelated tests. A policy change still retains full validation.

Execution expressions in jobs and inherited env/defaults are checked for hidden contexts. Routing metadata such as concurrency, run-name and on does not make every job opaque; ordinary names containing words such as inputs are harmless. Stale policy job IDs produce warnings and new jobs still run. Duplicate JSON policy keys are rejected.

Job and step if fields are expressions even without the usual expression delimiters. Hidden external contexts in either form keep the job fresh. Quoted terminator text inside an expression cannot hide a later secret or variable reference.

## Routing facts and resolved Actions

The scanner permits explicit github.event_name, github.sha, github.ref, github.ref_name, github.ref_type, github.base_ref, github.head_ref, github.event.pull_request.number, github.event.pull_request.base.sha and github.event.pull_request.head.sha routing expressions, plus simple matrix.NAME references with non-hidden matrix configuration. PR body/title, other GitHub event fields, runner contexts, bracket indexing, secrets/vars/inputs and external env remain opaque. Shell reads of common GITHUB/runner environment facts and event files, and common network commands, retain the job. These checks are bounded assistance, not shell/program analysis; inputsComplete still requires owner review of all transitive scripts.

Only workflows explicitly declaring the current event enter its plan. Missing or unrecognized triggers remain conservative; branch/path/activity filters are not evaluated. PR job-level conditions may still be conditional and are not evaluated.

A base-owned policy may allow Action tag resolution:

```json
{
  "allowActionPublishers": ["actions"],
  "actionPins": {
    "actions/checkout@v7": "3d3c42e5aac5ba805825da76410c181273ba90b1"
  }
}
```

These are optional fields added to a complete policy, not a complete policy by themselves. GitHub GET resolves the ref at plan time through authenticated gh; the returned SHA must equal the base-owned pin. The plan records and hashes all resolutions. A missing pin, moved tag, unknown publisher, failed API call or invalid response retains the job. Publisher allowlisting alone is insufficient: binding a newly resolved SHA into a hash would not prove it matches an owner's validated version. Prefer full SHA refs in workflows.

Local composite action metadata is read from the tested Git tree, recursively, with cycle/depth and byte bounds. Mutable nested actions, hidden contexts or unavailable metadata retain the calling job. Local reusable workflow calls stay opaque until their call inputs are modeled. Remote Actions internals are not fetched or analyzed.

A controlNeeds declaration is rejected when a named dependency's outputs are used outside if conditions; bracket/dynamic needs access also prevents treating the edge as control-only. Artifact relationships and runtime data in arbitrary scripts still need owner review.
