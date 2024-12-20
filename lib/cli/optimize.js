#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createDeflateRaw, constants as zlibConstants } from 'node:zlib';
import { BlockMap } from 'better-blockmap';
import yauzl from 'yauzl';
import yazl from '@indutny/yazl';
import { streamToBuffer, parseASAR } from '../util.js';

async function compressASAR(stream) {
  const asarBuffer = await streamToBuffer(stream);
  const { asar, fileMap } = parseASAR(asarBuffer);
  const sortedOffsets = Array.from(fileMap.keys()).sort((a, b) => a - b);

  const deflate = createDeflateRaw({
    level: zlibConstants.Z_BEST_COMPRESSION,
  });

  let last = 0;
  for (const offset of sortedOffsets) {
    deflate.write(asar.slice(last, offset));
    deflate.flush();
    last = offset;
  }
  deflate.end(asar.slice(last));
  deflate.end();

  return deflate;
}

export default async function optimize({
  inputPath,
  outputPath,
  blockMapPath,
}) {
  if (inputPath === outputPath) {
    throw new Error("Can't optimize in-place");
  }

  const input = await promisify(yauzl.open)(inputPath, {
    autoClose: false,
  });

  // Get all entries
  const entries = [];
  input.on('entry', (entry) => {
    entries.push(entry);
  });
  await once(input, 'end');

  // Sort them alphabetically for consistency
  entries.sort((a, b) => {
    if (a.fileName === b.fileName) {
      return 0;
    }
    return a.fileName < b.fileName ? -1 : 1;
  });

  // Generate output file
  const openReadStream = promisify(input.openReadStream).bind(input);
  const output = new yazl.ZipFile();

  // Add files one-by-one to avoid out of order placement
  for (const entry of entries) {
    if (entry.fileName.endsWith('/')) {
      output.addEmptyDirectory(entry.fileName, {
        mtime: entry.getLastModDate(),
        externalFileAttributes: entry.externalFileAttributes,
      });
      continue;
    }

    let stream;
    if (entry.fileName.endsWith('.asar')) {
      // eslint-disable-next-line no-await-in-loop
      const asarStream = await openReadStream(entry, {
        decompress: entry.isCompressed() ? true : null,
      });

      // Compress ASAR with a special algorithm
      // eslint-disable-next-line no-await-in-loop
      stream = await compressASAR(asarStream);
    } else {
      // eslint-disable-next-line no-await-in-loop
      stream = await openReadStream(entry, {
        decompress: entry.isCompressed() ? false : null,
      });
    }

    output.addReadStream(stream, entry.fileName, {
      mtime: entry.getLastModDate(),
      externalFileAttributes: entry.externalFileAttributes,
      compress: entry.isCompressed(),
      raw: !!entry.isCompressed(),
      crc32: entry.isCompressed() ? entry.crc32 : null,
      uncompressedSize: entry.uncompressedSize,
      forceZip64Format: false,
      fileComment: '',
    });
  }
  output.end();

  await pipeline(output.outputStream, createWriteStream(outputPath));

  if (blockMapPath) {
    const generator = new BlockMap({ detectZipBoundary: true });
    await pipeline(createReadStream(outputPath), generator);

    await writeFile(blockMapPath, generator.compress());
  }

  input.close();
}
