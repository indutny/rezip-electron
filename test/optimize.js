import { URL } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
// eslint-disable-next-line import/no-unresolved
import test from 'ava';
import yauzl from 'yauzl';

import { optimize } from '../lib/index.js';

async function parseZipFile(path) {
  const zip = await promisify(yauzl.open)(path, {
    autoClose: false,
  });

  const openReadStream = promisify(zip.openReadStream).bind(zip);

  const entries = [];
  zip.on('entry', (entry) => entries.push(entry));
  await once(zip, 'end');

  const result = await Promise.all(
    entries.map(async (entry) => {
      const { fileName, uncompressedSize, externalFileAttributes } = entry;
      const file = {
        fileName,
        uncompressedSize,
        externalFileAttributes,
      };

      if (entry.fileName.endsWith('/')) {
        return file;
      }

      const stream = await openReadStream(entry);

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      await once(stream, 'end');

      file.content = createHash('sha256')
        .update(Buffer.concat(chunks))
        .digest('hex');
      return file;
    }),
  );

  zip.close();

  result.sort((a, b) => {
    if (a.fileName === b.fileName) {
      return 0;
    }

    return a.fileName < b.fileName ? -1 : 1;
  });

  return result;
}

test('it preserves contents of zip file', async (t) => {
  const inputPath = new URL('./fixtures/a.zip', import.meta.url);
  const outputPath = new URL('./fixtures/a.zip.tmp', import.meta.url);
  const blockMapPath = new URL('./fixtures/a.blockmap.tmp', import.meta.url);

  await optimize({ inputPath, outputPath, blockMapPath });
  t.deepEqual(await parseZipFile(outputPath), await parseZipFile(inputPath));

  const blockMapData = await readFile(blockMapPath);
  const blockMap = JSON.parse(gunzipSync(blockMapData, 'utf8'));
  t.snapshot(blockMap, 'blockmap');
});

test('it preserves contents of fiddle installer', async (t) => {
  const inputPath = new URL('./fixtures/fiddle.zip.tmp', import.meta.url);
  try {
    await stat(inputPath);
  } catch {
    // eslint-disable-next-line no-console
    console.log('Downloading fiddle');
    const res = await fetch(
      'https://github.com/electron/fiddle/releases/download/v0.36.0/' +
        'Electron-Fiddle-darwin-arm64-0.36.0.zip',
    );
    if (!res.ok) {
      throw new Error('Failed to download');
    }

    await pipeline(res.body, createWriteStream(inputPath));
  }

  const outputPath = new URL('./fixtures/fiddle.opt.tmp', import.meta.url);
  const blockMapPath = new URL(
    './fixtures/fiddle.blockmap.tmp',
    import.meta.url,
  );

  await optimize({ inputPath, outputPath, blockMapPath });
  t.deepEqual(await parseZipFile(outputPath), await parseZipFile(inputPath));

  const blockMapData = await readFile(blockMapPath);
  const blockMap = JSON.parse(gunzipSync(blockMapData, 'utf8'));
  t.snapshot(blockMap, 'blockmap');
});
