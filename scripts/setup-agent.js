#!/usr/bin/env node

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function findOmp() {
  const candidates = process.env.OMP_BIN
    ? [resolve(process.env.OMP_BIN)]
    : (process.env.PATH || '').split(delimiter).map((dir) => join(dir, 'omp'));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('Install the compiled Linux OMP CLI first, or set OMP_BIN to its executable path.');
}

async function main() {
  const binary = await findOmp();
  const file = await open(binary, 'r');
  try {
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('OMP_BIN must be the compiled Linux OMP executable, not a script or package-manager shim.');
    }
  } finally {
    await file.close();
  }
  const image = process.env.OMP_DOCKER_IMAGE || 'telegram-omp-agent:local';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(image)) throw new Error('Invalid OMP_DOCKER_IMAGE.');
  const context = await mkdtemp(join(tmpdir(), 'telegram-omp-build-'));
  try {
    // Never send the repository, .env, or personal OMP configuration to Docker.
    await copyFile(binary, join(context, 'omp'));
    await copyFile(fileURLToPath(new URL('../Dockerfile.agent', import.meta.url)), join(context, 'Dockerfile'));
    console.log(`Building ${image} from the installed OMP executable.`);
    await new Promise((resolveBuild, reject) => {
      const child = spawn('docker', ['build', '--tag', image, context], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0
        ? resolveBuild()
        : reject(new Error(`Docker build failed (${signal || code}).`)));
    });
    console.log('OMP worker image is ready. Run npm start to launch the bot.');
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
