import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import Inflate from '@indutny/inflate';
import createRBTree from 'functional-red-black-tree';

export async function streamToBuffer(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  await once(stream, 'end');

  return Buffer.concat(chunks);
}

export function parseASAR(asar) {
  const headerSize = asar.readUint32LE(12);
  const header = JSON.parse(asar.slice(16, 16 + headerSize).toString());
  const fileMap = new Map();

  function crawl(fileOrDir, path) {
    if (fileOrDir.offset) {
      fileMap.set(16 + headerSize + parseInt(fileOrDir.offset, 10), path);
    }

    if (fileOrDir.files) {
      for (const [name, sub] of Object.entries(fileOrDir.files)) {
        crawl(sub, path ? `${path}/${name}` : name);
      }
    }
  }
  crawl(header, '');

  return { asar, fileMap };
}

export function getTreeRange(tree, from, to) {
  let iter = tree.le(from);
  if (!iter.valid) {
    iter = tree.begin;
  }

  const result = [];
  while (iter.valid) {
    const { key: sourceFrom, value } = iter;
    iter.next();

    const sourceTo = iter.valid ? iter.key : Infinity;

    const hasOverlap =
      (sourceFrom <= from && from <= sourceTo) ||
      (from <= sourceFrom && to >= sourceFrom);
    if (!hasOverlap) {
      break;
    }

    const rangeFrom = Math.max(from, sourceFrom);
    const rangeTo = Math.min(to, sourceTo);
    if (rangeFrom === rangeTo) {
      continue;
    }

    result.push({
      value,
      sourceFrom,
      from: rangeFrom,
      to: rangeTo,
    });
  }
  return result;
}

export async function createArchiveTree(compressedStream, isASAR = false) {
  const compressed = await streamToBuffer(compressedStream);

  // Create tree mapping compressed data offset to uncompressed data offset
  let inflateTree = createRBTree();
  inflateTree = inflateTree.insert(0, 0);

  let compressedOffset = 0;
  let uncompressedOffset = 0;

  const blocks = [];
  const inflate = new Inflate({
    onBlock(block) {
      uncompressedOffset += block.length;

      inflateTree = inflateTree.insert(compressedOffset, uncompressedOffset);
      blocks.push(Buffer.from(block));
    },
  });

  for (const byte of compressed) {
    compressedOffset += 1;
    inflate.push(byte);
  }
  inflate.finish();

  if (!isASAR) {
    return inflateTree;
  }

  const uncompressed = Buffer.concat(blocks, uncompressedOffset);

  // Create tree from uncompressed (asar) offset to a filename
  const { fileMap } = parseASAR(uncompressed);
  let asarTree = createRBTree();
  asarTree = asarTree.insert(0, '(header)');
  for (const [offset, fileName] of fileMap) {
    asarTree = asarTree.insert(offset, fileName);
  }

  // Create final tree mapping compressed offset to a filename
  let result = createRBTree();
  const iter = inflateTree.begin;
  while (iter.valid) {
    const fromCompressed = iter.key;
    const fromUncompressed = iter.value;
    iter.next();

    const toUncompressed = iter.valid ? iter.value : Infinity;

    const range = getTreeRange(asarTree, fromUncompressed, toUncompressed);
    for (const { value } of range) {
      result = result.insert(fromCompressed, value);
    }
  }

  return result;
}
