#!/usr/bin/env node
/* eslint-disable no-console */
import { program } from 'commander';
import optimize from '../lib/cli/optimize.js';
import compare from '../lib/cli/compare.js';

program
  .name('rezip-electron')
  .description(
    'Re-compress Electron macOS installer zip files ' +
      'for better incremental updates',
  );

program
  .command('optimize')
  .argument('<input>', 'input .zip file')
  .requiredOption('-o, --output <output>', 'output .zip file')
  .option('--blockmap <blockmap>', 'output .blockmap file')
  .summary('Optimize a .zip file')
  .action(async (inputPath, { output: outputPath, blockmap: blockMapPath }) => {
    await optimize({ inputPath, outputPath, blockMapPath });
  });

function formatSize(size) {
  if (size < 1024) {
    return `${size}b`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(2)}kb`;
  }

  return `${(size / 1024 / 1024).toFixed(2)}mb`;
}

program
  .command('compare')
  .argument('<previous>', 'previous version of .zip installer')
  .argument('<next>', 'next version of .zip installer')
  .option('--json', 'output raw json data')
  .summary('Compare two .zip installers')
  .action(async (previous, next, { json }) => {
    const raw = await compare(previous, next);

    if (json) {
      console.log(JSON.stringify(raw, null, 2));
      return;
    }

    const { downloadSize, modifiedFiles } = raw;

    console.log('File List:');
    for (const { resolvedPath, size } of modifiedFiles) {
      console.log(`  ${resolvedPath}: ${formatSize(size)}`);
    }
    console.log('');
    console.log('Total Download Size:', formatSize(downloadSize));
  });

await program.parseAsync(process.argv);
