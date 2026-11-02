# Repository completeness audit — 0.3.0

CI Planner can compare a repository's contents with the checks invoked by its GitHub Actions workflows.

```sh
ci-planner audit-repo --root /path/to/repository
ci-planner audit-repo --root /path/to/repository --ref FULL_COMMIT_SHA
```

Use node bin/ci-planner.mjs audit-repo when running from a clone. The command reads committed Git objects at HEAD or the supplied full SHA. Dirty files are ignored. It does not execute package scripts, fetch private source, read .env contents, edit workflows or start CI.

## What it looks for

| Repository evidence                            | Expected check                                      |
| ---------------------------------------------- | --------------------------------------------------- |
| Source files, tests or test scripts            | Package tests on PRs                                |
| TypeScript files or tsconfig                   | Checked TypeScript compilation                      |
| ESLint/Biome config, dependency or lint script | Lint without automatic fixes                        |
| Prettier/Biome configuration                   | Format check                                        |
| Declared build script                          | Actual build invocation                             |
| Package dependencies or lockfile               | Dependency vulnerability check                      |
| Source code                                    | Secret scan or owner-verified equivalent protection |
| Dockerfile                                     | Container build with the correct context/platform   |
| GitHub workflows                               | Workflow lint                                       |
| No unprivileged PR entry workflow              | PR validation entry point                           |

Package-specific rules initially target Node/TypeScript. Generic source, workflow and Docker signals are also reported. This is not a certification of coverage for other languages.

## How CI evidence is traced

The analyzer reads PR-triggered workflows, follows local reusable workflows and composite actions, resolves package scripts and follows simple shell wrappers. It tracks working directories and literal package-manager prefixes. Testing one package does not establish coverage for every package in a monorepo.

A script's name is not enough. An echo of npm test is not test coverage. Nonblocking checks, restricted workflow paths, arbitrary conditions, failure masking, help/dry-run arguments, dynamic selectors and opaque wrappers cannot establish unconditional blocking coverage.

Matrix completeness, remote reusable workflows, arbitrary JavaScript wrappers, exact Docker contexts and external GitHub protection settings may need manual review. The audit does not run repository code to guess what it would do.

## Report

Output is JSON with the exact ref, summary counts, checks, warnings and limitations. Each check includes repository evidence, CI locations, uncertainties and a suggested action. Raw command text and inline credential values are not included. Names and paths can still reveal private project structure; keep reports within the repository's access controls.

| Status      | Meaning                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| covered     | A recognized blocking invocation appears on a PR execution path. This does not prove that the check passed.              |
| conditional | Relevant invocation exists but is limited, nonblocking or otherwise cannot establish full coverage.                      |
| unverified  | An opaque workflow/action/wrapper or dynamic selection could contain the check. Review it.                               |
| missing     | No recognized invocation or opaque explanation was found in the inspected PR workflows. External checks may still exist. |

The audit does not verify branch protection, test quality, assertions, actual execution history, complete matrix coverage or external security settings. A green audit is not release approval.

## Add missing checks

Review findings against the repository's real commands and required-check contract. Add only the applicable checks through a small PR. For a Node repository, that may mean wiring its existing test/lint/typecheck scripts, adding npm audit, adding a redacted secret scan, and running actionlint. Review unsupported wrappers before adding duplicate work.

Preserve runner placement, secrets, event trust, coverage floors and release gates. Native app builds should remain on the owner's chosen internal runners. Do not create hosted app builds to satisfy a generic recommendation.

This release adds the confirmed gaps to CI Planner's own CI: the shipped Action runs against the repository, Node 22 and 24 run the suite, and dependency/secret/workflow scans block failures. These changes remain separate from the read-only audit command. The command does not silently commit changes or grant itself permissions.

## API and bounds

Import auditRepository or auditRepositorySnapshot from @gamenalyze/ci-planner/repository-audit.

- auditRepository({ root, ref }) reads bounded committed objects.
- auditRepositorySnapshot({ ref, files }) analyzes a trusted, bounded text/path snapshot for tests or adapters.

Limits: 20,000 tracked paths, 300 selected text files, 256 KiB per selected file, 8 MiB total selected text, 10 levels of traced calls and 10,000 visited CI steps. Cycles and unsupported references become visible uncertainty. Invalid manifests or exceeded read bounds fail the audit.

The rule set and public functions have source annotations. Fixtures cover missing checks, indirect wiring, monorepo isolation, disabled checks, failure masking, opaque references, redaction and immutable Git reads.

## Add confirmed gaps through a reviewable workflow

Run ci-planner audit-repo --root DIR --add-checks to create .github/workflows/ci-planner-checks.yml. This flag is explicit permission to write one new file; it does not commit, push, open a PR or start runners. Review the file, then submit it through your normal PR process. The default command stays read-only.

The generator uses only definite missing findings and verifiable existing direct Node check commands with an npm lockfile. It can add dependency checks and hash-verified secret/workflow scanners. It skips conditional/unverified findings, arbitrary wrappers, missing suites, native/build/container placement and unsupported package managers, and explains omissions. It cannot invent meaningful tests. It uses one unprivileged PR job, no extra secrets, disabled install hooks, and no privileged PR event.

Existing workflow files are never overwritten. Symlinked workflow parents are refused. Adding checks requires the current HEAD snapshot, so an old ref cannot silently become the basis for current writes. Read-only audits may still target an earlier full SHA.

Generated repository secret scans run before package installation and package checks. This keeps dependency fixtures and generated output out of the scan on a fresh checkout. The generator does not delete existing files or promise a source-only scan on a reused checkout; use a clean workspace when running the generated workflow.

Conditional prerequisites propagate to dependent checks unless an explicit supported status condition overrides the skipped dependency. Unconditional shell exits stop tracing, including inside package scripts and shell wrappers, so unreachable commands cannot count as validation.

## Reports and draft fix PRs

Add --format markdown or --summary for a readable view of these findings. The optional Action audit-repository input includes the same static evidence in its job summary without altering job decisions. See [reports](reports.md).

The new fix command previews the supported additive workflow without writing a local file. Explicit fix --repository OWNER/REPO --open-pr can publish it as a draft PR from a trusted local checkout at the remote default branch. This separate operation may start normal PR CI and requires write permission. It does not change audit-repo's read-only default or --add-checks semantics. See [guided setup and fix publication](onboarding-and-fixes.md).
