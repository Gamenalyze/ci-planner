/** Reproduce shipped parser bytes and the repository-specific SBOM from npm ci's lockfile graph. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const lock = JSON.parse(fs.readFileSync(new URL("package-lock.json", root)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outputs = new Map(),
  components = [];
for (const name of ["acorn", "yaml"]) {
  const base = new URL("node_modules/" + name + "/", root);
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", base)));
  const pinned = lock.packages["node_modules/" + name];
  if (
    pkg.name !== name ||
    pkg.version !== pinned.version ||
    pinned.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${pkg.version}.tgz` ||
    Object.keys(pkg.dependencies ?? {}).length !== 0 ||
    !pinned.integrity?.startsWith("sha512-") ||
    pkg.license !== (name === "yaml" ? "ISC" : "MIT")
  )
    throw Error("Unverified vendor package identity/license: " + name);
  const files =
    name === "acorn"
      ? ["dist/acorn.mjs"]
      : fs
          .readdirSync(new URL("browser/dist/", base), { recursive: true })
          .filter((n) => n.endsWith(".js"))
          .sort()
          .map((n) => "browser/dist/" + n);
  for (const file of [...files, "LICENSE"]) {
    const target = "vendor/" + name + "/" + file.replace(/^browser\//, "");
    outputs.set(target, fs.readFileSync(new URL(file, base)));
  }
  outputs.set(
    "vendor/" + name + "/package.json",
    Buffer.from(
      JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          type: "module",
          license: pkg.license,
        },
        null,
        2,
      ) + "\n",
    ),
  );
  const inventory = [...outputs]
    .filter(([n]) => n.startsWith("vendor/" + name + "/"))
    .map(([n, b]) => ({ path: n, sha256: hash(b) }));
  components.push({
    type: "library",
    name,
    version: pkg.version,
    "bom-ref": "pkg:npm/" + name + "@" + pkg.version,
    purl: "pkg:npm/" + name + "@" + pkg.version,
    licenses: [{ license: { id: pkg.license } }],
    hashes: [{ alg: "SHA-256", content: hash(JSON.stringify(inventory)) }],
    properties: [
      { name: "npm:lockfile:integrity", value: pinned.integrity },
      { name: "ci-planner:vendored-files", value: JSON.stringify(inventory) },
    ],
  });
}
outputs.set(
  "vendor/bom.cdx.json",
  Buffer.from(
    JSON.stringify(
      { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components },
      null,
      2,
    ) + "\n",
  ),
);
const write = process.argv.slice(2).join() === "--write";
if (process.argv.length > 2 && !write)
  throw Error("Expected no options or --write");
if (write) {
  fs.rmSync(new URL("vendor/", root), { recursive: true, force: true });
  for (const [name, bytes] of outputs) {
    fs.mkdirSync(path.dirname(new URL(name, root).pathname), {
      recursive: true,
    });
    fs.writeFileSync(new URL(name, root), bytes);
  }
} else {
  if (fs.lstatSync(new URL("vendor/", root)).isSymbolicLink()) throw Error("Symlinked vendor root");
  for (const name of fs.readdirSync(new URL("vendor/", root), {
    recursive: true,
  }))
    if (fs.lstatSync(new URL("vendor/" + name, root)).isSymbolicLink())
      throw Error("Symlink in vendored inventory");
  const actual = fs
    .readdirSync(new URL("vendor/", root), { recursive: true })
    .filter((n) => fs.lstatSync(new URL("vendor/" + n, root)).isFile())
    .map((n) => "vendor/" + n)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...outputs.keys()].sort()))
    throw Error("Vendored file inventory drift");
  for (const [name, bytes] of outputs)
    if (!fs.readFileSync(new URL(name, root)).equals(bytes))
      throw Error("Vendored parser/SBOM drift: " + name);
}
console.log(
  "Verified 2 licensed parser components, " +
    outputs.size +
    " pinned vendor/SBOM files.",
);
