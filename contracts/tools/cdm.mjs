// A Windows shim for the `cdm` CLI. On Linux/macOS it is a pass-through.
//
// THE BUG: `cdm build` (and `cdm deploy`, which builds first) shells out with
//     spawn("npx", ["hardhat", "compile"])
// and Node on Windows cannot start `npx` that way. Bare `npx` is a shell script with no
// extension, so libuv's PATH lookup fails -> ENOENT; and `npx.cmd` cannot be spawned without
// `shell: true` since Node's CVE-2024-27980 fix -> EINVAL. So on Windows every cdm build dies
// immediately with:
//     @yolodot/guestbook:
//     spawn npx ENOENT
//
// Reproduced on cdm 0.8.26 / Node 22.22.0, from both Git Bash and PowerShell. It is cdm's bug,
// not ours: the upstream fix is one option on its own runCommand,
//     spawn(cmd, args, { cwd, stdio, shell: process.platform === "win32" })
// (contract-dependency-manager, src/apps/cli, `runCommand` / `runCommandSyncJson`).
//
// THE SHIM: patch exactly that default into child_process before loading cdm's CLI in-process,
// then hand it our argv. Nothing else about cdm changes, and no global install is modified.
//
//   node tools/cdm.mjs build
//   node tools/cdm.mjs deploy -n devnet --suri "$MNEMONIC"
//
// Delete this file the day cdm ships the fix.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberately `require`, not `import`. Node builds a named-export facade for a builtin the first
// time it is ESM-imported and snapshots the function values into it; `import childProcess from
// 'node:child_process'` here would freeze the ORIGINAL spawn into that facade before we patch,
// and cdm's own `import { spawn }` would then get the unpatched one. Requiring the CJS object and
// mutating it leaves the facade uncreated until cdm imports it — by which time it snapshots ours.
const childProcess = createRequire(import.meta.url)('node:child_process');

const isWindows = process.platform === 'win32';

if (isWindows) {
    const withShell = (options) =>
        options && typeof options === 'object' && !Array.isArray(options)
            ? { ...options, shell: options.shell ?? true }
            : { shell: true };

    // cdm calls both, always as (cmd, args, options).
    for (const name of ['spawn', 'spawnSync']) {
        const original = childProcess[name].bind(childProcess);
        childProcess[name] = (command, args, options) => original(command, args, withShell(options));
    }
}

// `cdm` is installed globally, so resolve it through the global root rather than a relative path.
const globalRoot =
    process.env.NPM_GLOBAL_ROOT ??
    childProcess.execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: isWindows }).trim();

const cli = join(globalRoot, '@polkadot-community-foundation', 'cdm-cli', 'dist', 'cli.js');

if (!existsSync(cli)) {
    console.error(`cdm CLI not found at ${cli}`);
    console.error('Install it with:  npm i -g @polkadot-community-foundation/cdm-cli');
    console.error('Or set NPM_GLOBAL_ROOT to the directory that holds it.');
    process.exit(1);
}

await import(pathToFileURL(cli).href);
