// The server bundle leaves some packages external (scripts/lib/cli-external-packages.ts)
// and the deploy only syncs dist into the live install, so a newly external
// dependency has to be copied into the live node_modules before the dist swap.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [src, live] = process.argv.slice(2);
const { isRuntimeExternalCliDependency } = await import(
  NodePath.join(src, "scripts/lib/cli-external-packages.ts")
);
const serverPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(src, "apps/server/package.json"), "utf8"),
);
const srcModules = NodePath.join(src, "apps/server/node_modules");
const liveModules = NodePath.join(live, "apps/server/node_modules");

const manifestOf = (directory) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"));

// pnpm links a package's dependencies beside it in the virtual store, so the
// directory holding "node_modules" is where its runtime dependencies live.
const virtualRootOf = (packageDirectory) => {
  let current = NodePath.dirname(packageDirectory);
  while (current !== NodePath.dirname(current)) {
    if (NodePath.basename(current) === "node_modules") return current;
    current = NodePath.dirname(current);
  }
  return NodePath.dirname(packageDirectory);
};

const roots = Object.keys(serverPackage.dependencies ?? {}).filter(isRuntimeExternalCliDependency);
const queue = roots.map((name) => ({
  name,
  source: NodePath.join(srcModules, ...name.split("/")),
}));
const copied = [];
const seen = new Set();

while (queue.length > 0) {
  const { name, source } = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  if (!NodeFS.existsSync(NodePath.join(source, "package.json"))) continue;

  const packageDirectory = NodeFS.realpathSync(source);
  const manifest = manifestOf(packageDirectory);
  const target = NodePath.join(liveModules, ...name.split("/"));
  const existing = NodePath.join(target, "package.json");
  const stale = !NodeFS.existsSync(existing) || manifestOf(target).version !== manifest.version;
  if (stale) {
    NodeFS.rmSync(target, { recursive: true, force: true });
    NodeFS.cpSync(packageDirectory, target, { recursive: true, dereference: true });
    copied.push(`${name}@${manifest.version}`);
  }

  const virtualRoot = virtualRootOf(packageDirectory);
  for (const dependency of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]) {
    queue.push({
      name: dependency,
      source: NodePath.join(virtualRoot, ...dependency.split("/")),
    });
  }
}

if (copied.length > 0) {
  console.log(`synced runtime externals into ${liveModules}: ${copied.join(" ")}`);
}
