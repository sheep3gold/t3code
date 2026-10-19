// The server bundle leaves some packages external (scripts/lib/cli-external-packages.ts),
// but the deploy only syncs dist into the live install. A newly external dependency
// therefore crash-loops the live server with "Cannot find module" unless the live
// install's node_modules already has it, so fail before any live file is touched.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [src, live] = process.argv.slice(2);
const { isRuntimeExternalCliDependency } = await import(
  join(src, "scripts/lib/cli-external-packages.ts")
);
const serverPackage = JSON.parse(readFileSync(join(src, "apps/server/package.json"), "utf8"));
const roots = [join(live, "apps/server/node_modules"), join(live, "node_modules")];
const missing = Object.keys(serverPackage.dependencies ?? {})
  .filter(isRuntimeExternalCliDependency)
  .filter((name) => !roots.some((root) => existsSync(join(root, name, "package.json"))));

if (missing.length > 0) {
  console.error(
    `live install at ${live} is missing external runtime packages: ${missing.join(" ")}`,
  );
  process.exit(1);
}
