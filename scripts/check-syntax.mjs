import fs from "node:fs";
import { execFileSync } from "node:child_process";
for (const directory of ["bin", "src", "scripts"]) {
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    if (entry.endsWith(".mjs"))
      execFileSync(process.execPath, ["--check", directory + "/" + entry], {
        stdio: "inherit",
      });
  }
}
