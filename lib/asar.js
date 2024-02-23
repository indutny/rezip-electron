import { once } from 'node:events';

export default async function parseASAR(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  await once(stream, 'end');

  const asar = Buffer.concat(chunks);

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
