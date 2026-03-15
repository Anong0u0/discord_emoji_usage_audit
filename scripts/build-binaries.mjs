import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { targets } from './build-targets.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const entrypoint = path.join(projectRoot, 'main.js');
const outdir = path.join(projectRoot, 'dist');
const bundleDirPrefix = path.join(tmpdir(), 'emoji-audit-build-');
const pkgCli = path.join(projectRoot, 'node_modules', 'pkg', 'lib-es5', 'bin.js');

function runPkg(target, bundlePath, cachePath) {
  const outfile = path.join(outdir, target.binaryName);
  console.log(`Building ${target.label} -> ${path.relative(projectRoot, outfile)}`);

  const result = spawnSync(
    process.execPath,
    [
      pkgCli,
      '-t',
      target.pkgTarget,
      '--no-bytecode',
      '--public',
      '--public-packages',
      '*',
      '-o',
      outfile,
      bundlePath,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PKG_CACHE_PATH: cachePath,
      },
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const bundleTempDir = await mkdtemp(bundleDirPrefix);
const bundlePath = path.join(bundleTempDir, 'emoji-audit.bundle.cjs');
const cachePath = path.join(bundleTempDir, 'pkg-cache');

try {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: [entrypoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify: true,
    target: 'node18',
    define: {
      'globalThis.__EMOJI_AUDIT_PACKAGED__': 'true',
    },
    outfile: bundlePath,
  });

  for (const target of targets) {
    runPkg(target, bundlePath, cachePath);
  }
} finally {
  await rm(bundleTempDir, { recursive: true, force: true });
}
