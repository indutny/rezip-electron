import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { BlockMap } from 'better-blockmap';
import createRBTree from 'functional-red-black-tree';
import yauzl from 'yauzl';
import { createArchiveTree, getTreeRange } from '../util.js';

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
  const subTrees = new Map();
  await Promise.all(
    entries
      .filter((entry) => !entry.fileName.endsWith('/'))
      .map(async (entry) => {
        const { fileDataStart } = await readLocalFileHeader(entry);

        let subTree;

        if (entry.isCompressed()) {
          const compressedStream = await openReadStream(entry, {
            decompress: false,
          });
          subTree = await createArchiveTree(
            compressedStream,
            entry.fileName.endsWith('.asar'),
          );
        } else {
          subTree = createRBTree();
          subTree = subTree.insert(0, 0);
          subTree = subTree.insert(
            entry.compressedSize,
            entry.uncompressedSize,
          );
        }
        subTrees.set(entry.fileName, subTree);

        tree = tree.insert(fileDataStart, entry.fileName);
      }),
  );
  zip.close();

  let downloadSize = 0;
  const modifiedFiles = new Map();
  for (const { action, readOffset, size } of diff) {
    if (action !== 'download') {
      continue;
    }

    downloadSize += size;

    const range = getTreeRange(tree, readOffset, readOffset + size);
    for (const { value: path, from, to } of range) {
      const subTree = subTrees.get(path);
      if (!subTree) {
        throw new Error(`Unknown file: ${path}`);
      }

      const subRange = getTreeRange(subTree, from, to);
      for (const { value, from: subFrom, to: subTo } of subRange) {
        let fullPath = path;
        if (typeof value === 'string') {
          fullPath = `${fullPath}/${value}`;
        }

        modifiedFiles.set(
          fullPath,
          (modifiedFiles.get(fullPath) ?? 0) + (subTo - subFrom),
        );
      }
    }
  }

  const sortedFiles = Array.from(modifiedFiles.entries())
    .sort((left, right) => left[1] - right[1])
    .map(([path, size]) => ({ path, size }));

  return {
    downloadSize,
    modifiedFiles: sortedFiles,
  };
}
