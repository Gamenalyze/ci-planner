# Changelog

## 0.4.1 — 2026-11-03

- Point the shipped GitHub Actions example to an available release version instead of the unpublished v0.3.1 label.
- Replace the obsolete manual Marketplace release checklist with the verified automatic GitHub/Marketplace/npm workflow, environment and trusted-publisher requirements, and immutable-tag recovery steps.
- Make the npm quickstart directly usable and align package, engine and release examples for this documentation patch.

## 0.4.0 — 2026-11-03

- Close the remaining audit safety gaps: reject output-carrying controlNeeds, scan common shell event/network inputs and committed nested composite actions, retain nested shared manifests/configuration, and require attestation of the exact successful run head.
- Permit explicit routing expressions and literal matrix values, while retaining PR text, secrets, external env, dynamic contexts, and runner-dependent inputs. Filter plans to workflows that declare the current event.
- Resolve allowlisted Action publishers through GitHub and bind resolved SHAs to plan identity. Require a base-owned expected actionPins entry; a moved tag or unavailable resolution always retains the job.
- Cache compiled glob patterns across comparisons and correct the project's own input policy to cover docs tests, package contents and secret scans.
- Surface cancelled worker time, share and totals by conclusion, with cause left unknown. Add optional owner runner cost rates and expose incomplete pricing coverage.
- Aggregate per-job median, nearest-rank p90, shard ratios, install time and estimates from complete successful PR samples; combine repeated review prompts across runs.
- Propose actual source/script scopes and documentation ignores in init, leaving every completeness assertion false and mode shadow.
- Automatically create versioned GitHub releases with npm tarballs/checksums after both Node lanes pass on main, with an optional npm OIDC job that verifies identical tarball and registry bytes. Verify the exact source and public Marketplace latest version; publication failures remain visible and version tags never move.
- Lead with waste and missing-check audits. The first npm registry publication/trust bootstrap, live merged-PR replay, affected-test selection and broader language audits remain follow-up work.

## 0.3.1 — 2026-11-03

- Force Git to include submodule gitlink changes regardless of ignore settings in committed or dirty .gitmodules and local .git/config. A hidden gitlink change could otherwise bypass enforce-mode input selection in v0.3.0 and earlier.
- Add committed-ignore, local-config-ignore and dirty-worktree-ignore regression fixtures.
- Until upgraded to a reviewed v0.3.1 commit or release, keep enforce disabled. Shadow mode still runs every check.

## 0.3.0 — 2026-11-03

- Harden reuse trust to the target first-parent contract and reject skipped steps.
- Keep oversized dependency inputs as explicit unknowns instead of failing the scan; distinguish Git output bounds and missing evidence.
- Reject invalid summary counts, bind feedback to repository and exact shadow plan, and document GitHub bare-URL autolinks.

- Add bounded Markdown reports for plans, completeness audits, timing observations, setup previews and fix receipts. Existing result commands keep JSON by default.
- Show readable GitHub job summaries from the Action, with optional completeness evidence that cannot change selection or plan hashes.
- Add guided init previews and explicit exclusive writes for an advisory report workflow and an incomplete shadow policy. Existing policies and CI stay in place.
- Add offline fix previews and explicit local-only draft PR publication for supported missing checks. Exact default-branch binding, branch-collision refusal and drift checks protect existing refs.
- Compare shadow suggestions with explicit full-run observations; missing or unsafe optional feedback forces all planner jobs to run.
- Add advisory JS/TS workspace, package, literal import and TypeScript reference discovery; inferred scopes never assert complete inputs.
- Add owner-signed full-run attestations and explicit PR-to-main reuse verification with complete-tree, environment, expiry, default-branch and live-attempt checks. Missing evidence always runs fresh.
- Add timing advice for uneven shards, repeated installs, cache observations and late-finishing jobs. No savings or billing claims.
- Document all commands, coordinator trust boundaries, APIs, permissions, review steps and rollback. No model calls, hosted backend or general optimization rewrites are introduced.

## 0.2.1 — 2026-11-02

- Prepare the GitHub Marketplace Action metadata, versioned usage example and maintainer publishing instructions.
- Preserve a caller's Node.js 22+ runtime in the composite Action. Set up Node 24 only when the existing runtime is missing or unsupported, and document that fallback's PATH effect.
- Check the matrix runtime after the shipped Action, so Node 22 audits and package smoke tests cannot silently run on Node 24.
- Detect hidden expression contexts regardless of name casing, including implicit conditions.
- Run generated and project CI secret scans before package installation to avoid dependency fixtures and generated output on fresh checkouts.

## 0.2.0 — 2026-11-02

- Fix a skip bypass: changed producer inputs now invalidate downstream consumers, transitively. Upgrade before enabling enforcement.
- Scope hidden-input checks to execution expressions, not routing metadata or ordinary names.
- Add explicit reviewed controlNeeds for planner-only gating, bounded alias fallback, stale-job warnings, unique JSON policy keys and repository path hardening.
- Expand mandatory shared Git/toolchain inputs and document dotfile matching.
- Add repository-aware missing-check audits with source/config evidence and traced PR invocations.
- Exercise the shipped Action in CI, test Node 22/24, and add dependency, secret and workflow scans. The Action sets up its own Node runtime.
- Add public documentation, examples and adversarial regression coverage.

## 0.1.0 — 2026-11-02

Initial public release:

- Read-only Actions metadata audit and offline replay.
- Worker-time accounting with partial observations and review findings.
- Workflow/job discovery rebuilt on each plan.
- Base-owned explicit input policies, shadow mode and optional enforcement.
- Exact source/merge identity, producer retention and run-all fallback.
- CLI, composite Action, examples, JSON Schema and annotated public APIs.

This release has no hosted service, model dependency, automatic workflow edits, source dependency inference or cross-run qualification reuse.
