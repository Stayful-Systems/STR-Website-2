/**
 * Batch 37: a ZIP file from a map of name -> content, with no dependency.
 * Each entry is deflated (node:zlib deflateRawSync) and checked with a CRC-32
 * (zlib.crc32, Node 22+). Names are written as UTF-8 (general purpose flag bit 11).
 * The archive has local headers, a central directory and an end record; there is
 * no ZIP64, so more than 65535 files or any size over 4 GiB is refused.
 *
 * Output is deterministic: the same files give the same bytes (a fixed 1 Jan 1980
 * timestamp), in the order the map lists them. Names use forward slashes and are
 * relative: an absolute path, a backslash, or a "." / ".." part throws.
 *
 * Pure: no network, no database, no file system.
 */
import { crc32, deflateRawSync } from 'node:zlib';

const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;
const VERSION = 20;
/** 1 Jan 1980 00:00:00 in MS-DOS date and time. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

export type ZipInput = Record<string, Uint8Array | string>;

function checkName(name: string): void {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new Error('zip: bad file name');
  for (const part of name.split('/')) {
    if (part === '' && name.endsWith('/')) continue;
    if (part === '' || part === '.' || part === '..') throw new Error('zip: bad file name');
  }
}

export function zipFiles(files: ZipInput): Uint8Array {
  const names = Object.keys(files);
  if (names.length > MAX_ENTRIES) throw new Error('zip: too many files');

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    checkName(name);
    const raw = files[name];
    const data = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const packed = deflateRawSync(data);
    if (data.length > MAX_SIZE || packed.length > MAX_SIZE || offset > MAX_SIZE) throw new Error('zip: too large');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(VERSION, 4);
    lh.writeUInt16LE(UTF8_FLAG, 6);
    lh.writeUInt16LE(METHOD_DEFLATE, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBytes, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(VERSION, 4); // made by
    ch.writeUInt16LE(VERSION, 6); // needed
    ch.writeUInt16LE(UTF8_FLAG, 8);
    ch.writeUInt16LE(METHOD_DEFLATE, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal attrs: 0
    ch.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); // external attrs: directory bit
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBytes);

    offset += lh.length + nameBytes.length + packed.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > MAX_SIZE) throw new Error('zip: too large');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  const out = Buffer.concat([...local, ...central, end]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
