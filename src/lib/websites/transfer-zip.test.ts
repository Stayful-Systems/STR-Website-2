import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';
import { zipFiles } from './transfer-zip.ts';

interface Entry {
  name: string;
  crc: number;
  method: number;
  flags: number;
  data: Buffer;
}

/** A small independent reader: end record, central directory, then each local entry. */
function readZip(zip: Uint8Array): Entry[] {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const endAt = buf.length - 22;
  assert.equal(buf.readUInt32LE(endAt), 0x06054b50, 'end of central directory signature');
  const count = buf.readUInt16LE(endAt + 10);
  assert.equal(buf.readUInt16LE(endAt + 8), count);
  const cdSize = buf.readUInt32LE(endAt + 12);
  const cdOffset = buf.readUInt32LE(endAt + 16);
  assert.equal(cdOffset + cdSize, endAt, 'central directory ends where the end record starts');

  const out: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;

    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'local header signature');
    assert.equal(buf.readUInt32LE(lho + 14), crc, 'local crc matches central');
    assert.equal(buf.readUInt16LE(lho + 26), nlen);
    const dataAt = lho + 30 + nlen + buf.readUInt16LE(lho + 28);
    const packed = buf.subarray(dataAt, dataAt + csize);
    assert.equal(method, 8);
    const data = inflateRawSync(packed);
    assert.equal(data.length, usize, 'uncompressed size');
    out.push({ name, crc, method, flags, data });
  }
  assert.equal(p, endAt);
  return out;
}

test('every name, CRC and body comes back out of the central directory', () => {
  const big = Buffer.alloc(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  const files = {
    'index.html': '<!doctype html><title>Hi</title>',
    'assets/site.css': 'body{color:#123}'.repeat(500),
    'images/photo.bin': new Uint8Array(big),
    'empty.txt': '',
    'about/café ☕.html': '<p>naïve</p>',
  };
  const entries = readZip(zipFiles(files));
  assert.deepEqual(entries.map((e) => e.name), Object.keys(files));
  for (const e of entries) {
    const src = (files as Record<string, string | Uint8Array>)[e.name];
    const expected = typeof src === 'string' ? Buffer.from(src, 'utf8') : Buffer.from(src);
    assert.equal(e.crc, crc32(expected) >>> 0, e.name);
    assert.deepEqual(e.data, expected, e.name);
    assert.ok(e.flags & 0x0800, `${e.name} has the UTF-8 flag`);
  }
});

test('the same files give the same bytes, and an empty map is a valid empty archive', () => {
  const a = zipFiles({ 'a.txt': 'one', 'b.txt': 'two' });
  const b = zipFiles({ 'a.txt': 'one', 'b.txt': 'two' });
  assert.deepEqual(a, b);
  assert.ok(a instanceof Uint8Array);
  assert.equal(a[0], 0x50);
  assert.equal(a[1], 0x4b);
  const empty = zipFiles({});
  assert.equal(empty.length, 22);
  assert.deepEqual(readZip(empty), []);
});

test('a name that could escape the folder is refused', () => {
  for (const bad of ['', '/etc/passwd', '../x.html', 'a/../b.html', 'a\\b.html', './a.html', 'a//b.html']) {
    assert.throws(() => zipFiles({ [bad]: 'x' }), /bad file name/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => zipFiles({ 'assets/fonts/a.woff2': 'x' }));
});
