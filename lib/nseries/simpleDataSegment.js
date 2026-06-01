'use strict';

/**
 * Omron-specific "simple data segment" path component, appended to a variable's symbolic path
 * to read or write a chunk of data at a given offset. Used by the multi-message read/write
 * machinery for strings, arrays, and structures that exceed a single UCMM frame.
 *
 *   0x80 (simple-data segment type)
 *   0x03 (segment length, in 16-bit words; fixed)
 *   offset (uint32 LE)
 *   size   (uint16 LE)
 *
 * Total: 8 bytes, word-aligned.
 */
class SimpleDataSegmentRequest {
  constructor(offset, size) {
    this.offset = offset;
    this.size = size;
  }
  bytes() {
    const off = Buffer.alloc(4); off.writeUInt32LE(this.offset, 0);
    const sz  = Buffer.alloc(2); sz.writeUInt16LE(this.size, 0);
    return Buffer.concat([Buffer.from([0x80, 0x03]), off, sz]);
  }
}

module.exports = { SimpleDataSegmentRequest };
