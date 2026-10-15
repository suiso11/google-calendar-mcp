#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [join(__dirname, '../src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: join(__dirname, '../build/index.js'),
  format: 'esm',
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  packages: 'external', // Don't bundle node_modules
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const authServerBuildOptions = {
  entryPoints: [join(__dirname, '../src/auth-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: join(__dirname, '../build/auth-server.js'),
  format: 'esm',
  packages: 'external', // Don't bundle node_modules
  sourcemap: true,
};

// M5 dedicated reschedule entrypoint (ADDITIVE, separate bundle).
// The readonly bundles above (`build/index.js`, `build/auth-server.js`) are
// untouched: this builds ONLY `src/reschedule-cli.ts` (sources confined to
// `src/reschedule/`) into `build/reschedule-cli.js` (bin
// `calendar-reschedule-mcp`). `npm run build` keeps building every bundle,
// exactly as before plus this one; `npm run build:reschedule` builds only
// the separate entrypoint.
/** @type {import('esbuild').BuildOptions} */
const rescheduleBuildOptions = {
  entryPoints: [join(__dirname, '../src/reschedule-cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: join(__dirname, '../build/reschedule-cli.js'),
  format: 'esm',
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  packages: 'external', // Don't bundle node_modules
  sourcemap: true,
};

const rescheduleOnly = process.argv.includes('--reschedule-only');

if (isWatch) {
  const context = await esbuild.context(buildOptions);
  const authContext = await esbuild.context(authServerBuildOptions);
  await Promise.all([context.watch(), authContext.watch()]);
  process.stderr.write('Watching for changes...\n');
} else if (rescheduleOnly) {
  await esbuild.build(rescheduleBuildOptions);

  // Make the file executable on non-Windows platforms
  if (process.platform !== 'win32') {
    const { chmod } = await import('fs/promises');
    await chmod(rescheduleBuildOptions.outfile, 0o755);
  }
} else {
  await Promise.all([
    esbuild.build(buildOptions),
    esbuild.build(authServerBuildOptions),
    esbuild.build(rescheduleBuildOptions)
  ]);

  // Make the file executable on non-Windows platforms
  if (process.platform !== 'win32') {
    const { chmod } = await import('fs/promises');
    await chmod(buildOptions.outfile, 0o755);
    await chmod(rescheduleBuildOptions.outfile, 0o755);
  }

  // Copy static files (HTML, CSS, etc.) to build directory
  const { mkdir, copyFile } = await import('fs/promises');
  const webDir = join(__dirname, '../build/web');
  await mkdir(webDir, { recursive: true });

  const staticFiles = [
    'accounts.html',
    'auth-landing.html',
    'auth-success.html',
    'auth-error.html',
    'styles.css'
  ];

  await Promise.all(staticFiles.map(file =>
    copyFile(
      join(__dirname, '../src/web', file),
      join(webDir, file)
    )
  ));
  process.stderr.write('Static files copied to build directory\n');
} 