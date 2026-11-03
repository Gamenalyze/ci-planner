import test from "node:test";
import assert from "node:assert/strict";
import { auditRepositorySnapshot } from "../src/repository-audit.mjs";
const audit = (files, run) =>
  auditRepositorySnapshot({
    ref: "a".repeat(40),
    files: {
      ...files,
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  validate:\n    steps:\n      - run: |\n" +
        run
          .split("\n")
          .map((s) => "          " + s)
          .join("\n") +
        "\n",
    },
  });
const find = (r, kind, language) =>
  r.checks.find((c) => c.check === kind && c.language === language);
test("Python-only roots have recognized, conditional, opaque and missing evidence", () => {
  const files = {
    "pyproject.toml": "[project]",
    "src/a.py": null,
    "tests/test_a.py": null,
  };
  const covered = audit(
    files,
    "python -m pytest\nruff check .\npython -m pip-audit",
  );
  for (const k of ["tests", "lint", "dependency-audit"])
    assert.equal(find(covered, k, "python").status, "covered", k);
  assert.equal(
    find(audit(files, "pytest -k unit"), "tests", "python").status,
    "conditional",
  );
  assert.equal(
    find(audit(files, "make test"), "tests", "python").status,
    "unverified",
  );
  assert.equal(
    find(audit(files, "echo no validation"), "tests", "python").status,
    "missing",
  );
  assert.notEqual(
    find(audit(files, "pytest --collect-only"), "tests", "python").status,
    "covered",
  );
  assert.notEqual(
    find(audit(files, "ruff format ."), "lint", "python").status,
    "covered",
  );
});
test("Go-only roots require matching root, full package pattern and actual validation", () => {
  const files = {
    "go.mod": "module example.invalid/demo",
    "main.go": null,
    "main_test.go": null,
  };
  const covered = audit(
    files,
    "go test ./...\ngo vet ./...\ngo build ./...\ngovulncheck ./...",
  );
  for (const k of ["tests", "lint", "build", "dependency-audit"])
    assert.equal(find(covered, k, "go").status, "covered", k);
  for (const cmd of ["go test ./pkg", "go test ./... -run Unit"])
    assert.equal(find(audit(files, cmd), "tests", "go").status, "conditional");
  assert.notEqual(
    find(audit(files, "go test -list . ./..."), "tests", "go").status,
    "covered",
  );
  assert.notEqual(
    find(audit(files, "go test ./... || true"), "tests", "go").status,
    "covered",
  );
  assert.equal(
    find(audit(files, "make test"), "tests", "go").status,
    "unverified",
  );
});
test("Docker-only rules bind each explicit Dockerfile; generic, target and masked builds need review", () => {
  const files = {
    Dockerfile: "FROM scratch",
    "ops/Dockerfile": "FROM scratch",
  };
  const result = audit(files, "docker build .\nhadolint Dockerfile");
  const checks = result.checks.filter((c) => c.check === "container-build");
  assert.equal(
    checks.find((c) => c.repositoryEvidence[0] === "Dockerfile").status,
    "covered",
  );
  assert.equal(
    checks.find((c) => c.repositoryEvidence[0] === "ops/Dockerfile").status,
    "missing",
  );
  assert.equal(
    result.checks.find(
      (c) =>
        c.check === "container-lint" &&
        c.repositoryEvidence[0] === "Dockerfile",
    ).status,
    "covered",
  );
  for (const cmd of ["docker build --target test .", "docker build . || true"])
    assert.equal(
      audit(files, cmd).checks.find((c) => c.check === "container-build")
        .status,
      "conditional",
    );
  assert.equal(
    audit(files, "make build").checks.find((c) => c.check === "container-build")
      .status,
    "unverified",
  );
});
