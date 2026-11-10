#!/usr/bin/env node
// Thin launcher so `falcon` works after `npm link` or a global install; Node 22.18+ strips types natively.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
