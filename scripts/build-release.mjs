import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { create as createTar } from 'tar';
import yazl from 'yazl';
import { targets } from './build-targets.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const distDir = path.join(projectRoot, 'dist');
const releaseDir = path.join(projectRoot, 'release');
const buildScript = path.join(scriptDir, 'build-binaries.mjs');
const configTemplate = path.join(projectRoot, 'config.example.yml');
const envTemplate = path.join(projectRoot, '.env.example');

function runBuild() {
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function createTarGz(sourceDir, archivePath) {
  await createTar(
    {
      gzip: true,
      cwd: path.dirname(sourceDir),
      file: archivePath,
      portable: true,
    },
    [path.basename(sourceDir)],
  );
}

function createZip(entries, archivePath) {
  const zip = new yazl.ZipFile();

  for (const entry of entries) {
    zip.addFile(entry.source, entry.name);
  }

  return new Promise((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(archivePath))
      .on('close', resolve)
      .on('error', reject);

    zip.end();
  });
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

runBuild();

const stagingRoot = await mkdtemp(path.join(tmpdir(), 'emoji-audit-release-'));

try {
  for (const target of targets) {
    const packageDirName = `emoji-audit-${target.id}`;
    const packageDir = path.join(stagingRoot, packageDirName);
    const binarySource = path.join(distDir, target.binaryName);
    const configTarget = path.join(packageDir, 'config.yml');
    const envTarget = path.join(packageDir, '.env');
    const archivePath = path.join(
      releaseDir,
      target.id.startsWith('windows')
        ? `${packageDirName}.zip`
        : `${packageDirName}.tar.gz`,
    );

    await mkdir(packageDir, { recursive: true });
    await copyFile(binarySource, path.join(packageDir, target.binaryName));
    await copyFile(configTemplate, configTarget);
    await copyFile(envTemplate, envTarget);

    console.log(`Packaging ${target.label} -> ${path.relative(projectRoot, archivePath)}`);

    if (target.id.startsWith('windows')) {
      await createZip(
        [
          { source: path.join(packageDir, target.binaryName), name: `${packageDirName}/${target.binaryName}` },
          { source: configTarget, name: `${packageDirName}/config.yml` },
          { source: envTarget, name: `${packageDirName}/.env` },
        ],
        archivePath,
      );
      continue;
    }

    await createTarGz(packageDir, archivePath);
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
