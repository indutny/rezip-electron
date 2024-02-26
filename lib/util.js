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

export async function createASARTree(compressedStream) {
  const compressed = await streamToBuffer(compressedStream);

  // Create tree mapping compressed data offset to uncompressed data offset
  let compressedTree = createRBTree();
  compressedTree = compressedTree.insert(0, 0);

  let compressedOffset = 0;
  let uncompressedOffset = 0;

  const blocks = [];
  const inflate = new Inflate({
    onBlock(block) {
      uncompressedOffset += block.length;
      compressedTree = compressedTree.insert(
        compressedOffset,
        uncompressedOffset,
      );
      blocks.push(Buffer.from(block));
    },
  });

  for (const byte of compressed) {
    inflate.push(byte);
    compressedOffset += 1;
  }
  inflate.finish();

  // Create tree from uncompressed (asar) offset to a filename
  const { fileMap } = parseASAR(Buffer.concat(blocks, uncompressedOffset));
  let uncompressedTree = createRBTree();
  uncompressedTree = uncompressedTree.insert(0, '');
  for (const [offset, fileName] of fileMap) {
    uncompressedTree = uncompressedTree.insert(offset, fileName);
  }

  // Create final tree mapping compressed offset to a filename
  let result = createRBTree();
  compressedTree.forEach((fromOffset, toOffset) => {
    const { value: filename } = uncompressedTree.le(toOffset);
    result = result.insert(fromOffset, filename);
  });

  return result;
}
