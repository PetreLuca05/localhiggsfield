/* Builds the Next app as a standalone server and lays it out in
   electron-server/ for the Electron shell to run. The copy dereferences
   pnpm's symlinked node_modules so the folder is self-contained on Windows. */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");
const out = join(root, "electron-server");

const build = spawnSync(
  process.execPath,
  [join(root, "node_modules", "next", "dist", "bin", "next"), "build"],
  { cwd: root, stdio: "inherit", env: { ...process.env, OHF_STANDALONE: "1" } },
);
if (build.status !== 0) process.exit(build.status ?? 1);

if (!existsSync(join(standalone, "server.js"))) {
  console.error("next build did not produce .next/standalone/server.js");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, {
  recursive: true,
  dereference: true,
  /* Settings come from the Electron settings file at runtime, never from
     whatever .env happened to sit in the repo at build time. */
  filter: (src) => !/[\\/]\.env[^\\/]*$/.test(src),
});
hoistPnpmStore(join(out, "node_modules"));
cpSync(join(root, ".next", "static"), join(out, ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(out, "public"), { recursive: true });

console.log(`Electron server ready in ${out}`);

/* Once dereferenced, a top-level package such as next no longer sits beside
   its own dependencies inside .pnpm/, so Node cannot resolve them. pnpm keeps
   every package hoisted in .pnpm/node_modules; lift those to the top level the
   way npm would lay them out, then drop the store. */
function hoistPnpmStore(modules) {
  const store = join(modules, ".pnpm", "node_modules");
  if (!existsSync(store)) return;
  for (const entry of readdirSync(store)) {
    const names = entry.startsWith("@")
      ? readdirSync(join(store, entry)).map((name) => join(entry, name))
      : [entry];
    for (const name of names) {
      const target = join(modules, name);
      if (!existsSync(target)) cpSync(join(store, name), target, { recursive: true });
    }
  }
  rmSync(join(modules, ".pnpm"), { recursive: true, force: true });
}
