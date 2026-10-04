import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("build removes stale client artifacts and emits only the current server", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixture = await mkdtemp(join(tmpdir(), "a2a-server-build-"));
  try {
    for (const path of ["src", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
      await cp(join(root, path), join(fixture, path), { recursive: true });
    }
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
    await mkdir(join(fixture, "dist/client"), { recursive: true });
    await writeFile(join(fixture, "dist/client/index.js"), "export const stale = true;\n");
    await promisify(execFile)("npm", ["run", "build"], { cwd: fixture, timeout: 30_000 });
    const files = await readdir(join(fixture, "dist"), { recursive: true });
    expect(files).toContain("main.js");
    expect(files.some((file) => /(^|[/\\])client([/\\]|$)/.test(file))).toBe(false);
    expect(files.some((file) => /(?:delegation|tool-policy)\./.test(file))).toBe(false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 35_000);
