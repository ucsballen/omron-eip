'use strict';
/**
 * CIP CRC-16 (Modbus-style, polynomial 0xA001).
 * Used to validate structure type definitions on write_tag with abbreviated-structure type.
 * Ported from aphyt cip_crc16().
 *
 * @param {Buffer} data
 * @returns {Buffer} 2-byte CRC, little-endian
 */
function cipCrc16(data) {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      const carry = crc & 1;
      crc >>>= 1;
      if (carry) crc ^= 0xA001;
    }
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(crc & 0xFFFF, 0);
  return buf;
}

module.exports = { cipCrc16 };
