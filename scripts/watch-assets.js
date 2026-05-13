import { spawn } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import watch from 'node-watch';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(rootDir, 'src');
const npmCommand = process.platform === 'win32' ? 'npm run prepare' : 'npm';
const watchedExtensions = new Set(['.css', '.js']);

let buildProcess = null;
let rerunQueued = false;
let debounceTimer = null;

function schedulePrepare(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runPrepare(reason), 150);
}

function runPrepare(reason) {
  if (buildProcess) {
    rerunQueued = true;
    return;
  }

  console.log(`[watch] npm run prepare (${reason})`);
  buildProcess = process.platform === 'win32'
    ? spawn(npmCommand, {
        cwd: rootDir,
        shell: true,
        stdio: 'inherit'
      })
    : spawn(npmCommand, ['run', 'prepare'], {
        cwd: rootDir,
        stdio: 'inherit'
      });

  buildProcess.on('exit', (code, signal) => {
    buildProcess = null;

    if (signal) {
      console.error(`[watch] prepare exited from signal ${signal}`);
    } else if (code !== 0) {
      console.error(`[watch] prepare exited with code ${code}`);
    }

    if (rerunQueued) {
      rerunQueued = false;
      schedulePrepare('queued change');
    }
  });
}

function cleanup(exitCode) {
  clearTimeout(debounceTimer);
  watcher.close();
  if (buildProcess) {
    buildProcess.kill('SIGTERM');
  }
  process.exit(exitCode);
}

const watcher = watch(sourceDir, {
  recursive: true,
  filter: (filePath) => watchedExtensions.has(extname(filePath).toLowerCase())
}, (eventType, filename) => {
  if (typeof filename !== 'string') {
    schedulePrepare(eventType);
    return;
  }

  const relativePath = filename.replace(/\\/g, '/');
  schedulePrepare(`${eventType} ${relativePath}`);
});

watcher.on('error', (error) => {
  console.error('[watch] File watcher failed.');
  console.error(error);
  cleanup(1);
});

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

console.log(`[watch] Watching ${sourceDir} for asset changes`);
runPrepare('startup');