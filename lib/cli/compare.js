import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { BlockMap } from 'better-blockmap';
import createRBTree from 'functional-red-black-tree';
import yauzl from 'yauzl';
import { parseASAR } from '../util.js';

async function getBlocks(filePath) {
  const generator = new BlockMap({ detectZipBoundary: true });
  await pipeline(createReadStream(filePath), generator);

  const { files } = generator.toObject();
  const [file] = files;
  let { offset } = file;

  const blocks = [];
  for (const [i, checksum] of file.checksums.entries()) {
    const size = file.sizes[i];

    blocks.push({
      offset,
      size,
      checksum,
    });

    offset += size;
  }

  return blocks;
}

function computeDiff(oldFile, newFile) {
  const oldChecksums = new Map();
  for (const oldBlock of oldFile) {
    let list = oldChecksums.get(oldBlock.checksum);
    if (!list) {
      list = [];
      oldChecksums.set(oldBlock.checksum, list);
    }

    list.push(oldBlock);
  }

  const diff = [];

  let writeOffset = 0;
  for (const newBlock of newFile) {
    const oldBlocks = oldChecksums.get(newBlock.checksum);
    if (oldBlocks) {
      const oldBlock = oldBlocks.shift();
      if (oldBlocks.length === 0) {
        oldChecksums.delete(newBlock.checksum);
      }

      if (oldBlock.size !== newBlock.size) {
        throw new Error(
          `Block size mismatch: ${newBlock.checksum}, ` +
            `${oldBlock.size} != ${newBlock.size}`,
        );
      }

      diff.push({
        action: 'copy',
        size: oldBlock.size,
        readOffset: oldBlock.offset,
        writeOffset,
      });
      writeOffset += oldBlock.size;
      continue;
    }

    diff.push({
      action: 'download',
      size: newBlock.size,
      readOffset: newBlock.offset,
      writeOffset,
    });
    writeOffset += newBlock.size;
  }

  const optimizedDiff = [];
  for (const entry of diff) {
    const last =
      optimizedDiff.length !== 0
        ? optimizedDiff[optimizedDiff.length - 1]
        : undefined;

    const { action, readOffset, size } = entry;
    if (
      !last ||
      last.action !== action ||
      last.readOffset + last.size !== readOffset
    ) {
      optimizedDiff.push(entry);
      continue;
    }

    last.size += size;
  }

  return optimizedDiff.filter(({ size }) => size !== 0);
}

export default async function compare(oldFile, newFile) {
  const [a, b] = await Promise.all([getBlocks(oldFile), getBlocks(newFile)]);

  const diff = computeDiff(a, b);

  const zip = await promisify(yauzl.open)(newFile, {
    autoClose: false,
  });
  const entries = [];
  zip.on('entry', (entry) => entries.push(entry));
  await once(zip, 'end');

  const readLocalFileHeader = promisify(zip.readLocalFileHeader).bind(zip);
  const openReadStream = promisify(zip.openReadStream).bind(zip);

  let tree = createRBTree();
  let asarTree = createRBTree();
  await Promise.all(
    entries
      .filter((entry) => !entry.fileName.endsWith('/'))
      .map(async (entry) => {
        const { fileDataStart } = await readLocalFileHeader(entry, {
          minimal: true,
        });
        if (entry.fileName.endsWith('.asar')) {
          const stream = await openReadStream(entry);
          const { fileMap } = await parseASAR(stream);

          asarTree = asarTree.insert(0, '');
          for (const [offset, fileName] of fileMap) {
            asarTree = asarTree.insert(offset, fileName);
          }
        }
        tree = tree.insert(fileDataStart, entry.fileName);
      }),
  );
  zip.close();

  let downloadSize = 0;
  const modifiedFiles = [];
  for (const { action, readOffset, size } of diff) {
    if (action === 'download') {
      downloadSize += size;

      const zipNode = tree.le(readOffset);

      if (!zipNode.valid) {
        continue;
      }
      const { key: zipOffset, value: originalPath } = zipNode;

      const fileOffset = readOffset - zipOffset;

      let resolvedOffset = fileOffset;
      let resolvedPath = originalPath;
      let subPath;
      if (originalPath.endsWith('.asar')) {
        const { value: asarPath, key: asarOffset } = asarTree.le(fileOffset);

        if (asarPath) {
          subPath = asarPath;
          resolvedPath += `/${asarPath}`;
        }
        resolvedOffset -= asarOffset;
      }

      modifiedFiles.push({
        resolvedPath,
        originalPath,
        subPath,
        resolvedOffset,
        fileOffset,
        zipOffset,
        size,
      });
    }
  }

  return {
    downloadSize,
    modifiedFiles,
  };
}
