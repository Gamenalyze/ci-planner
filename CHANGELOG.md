# Changelog

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
