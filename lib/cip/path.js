'use strict';
/**
 * CIP path segment builders.
 * Ported from aphyt cip.py address_request_path_segment() and variable_request_path_segment().
 */

/**
 * Build a logical-segment path from class / instance / attribute / element IDs.
 * Each argument is a Buffer of 1, 2, or (for element) 4 bytes — length determines whether the
 * 8-bit form (0x20/0x24/0x30/0x28) or the 16-bit form (0x21 00/0x25 00/0x31 00/0x29 00) is used.
 * A 4-byte element uses 0x2A 00.
 *
 * @param {Object} args
 * @param {Buffer|null} [args.classId]
 * @param {Buffer|null} [args.instanceId]
 * @param {Buffer|null} [args.attributeId]
 * @param {Buffer|null} [args.elementId]
 * @returns {Buffer}
 */
function addressRequestPathSegment({ classId = null, instanceId = null, attributeId = null, elementId = null } = {}) {
  const parts = [];

  if (classId) {
    if (classId.length === 1)      parts.push(Buffer.from([0x20]), classId);
    else if (classId.length === 2) parts.push(Buffer.from([0x21, 0x00]), classId);
    else throw new TypeError(`classId must be 1 or 2 bytes, got ${classId.length}`);
  }
  if (instanceId) {
    if (instanceId.length === 1)      parts.push(Buffer.from([0x24]), instanceId);
    else if (instanceId.length === 2) parts.push(Buffer.from([0x25, 0x00]), instanceId);
    else throw new TypeError(`instanceId must be 1 or 2 bytes, got ${instanceId.length}`);
  }
  if (attributeId) {
    if (attributeId.length === 1)      parts.push(Buffer.from([0x30]), attributeId);
    else if (attributeId.length === 2) parts.push(Buffer.from([0x31, 0x00]), attributeId);
    else throw new TypeError(`attributeId must be 1 or 2 bytes, got ${attributeId.length}`);
  }
  if (elementId) {
    if (elementId.length === 1)      parts.push(Buffer.from([0x28]), elementId);
    else if (elementId.length === 2) parts.push(Buffer.from([0x29, 0x00]), elementId);
    else if (elementId.length === 4) parts.push(Buffer.from([0x2A, 0x00]), elementId);
    else throw new TypeError(`elementId must be 1, 2, or 4 bytes, got ${elementId.length}`);
  }

  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

/**
 * Build an extended-symbol segment for one identifier token.
 *   0x91 + length + UTF-8 name, zero-padded to even byte count.
 */
function _extendedSymbolSegment(name) {
  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.from([0x91, nameBuf.length]);
  let seg = Buffer.concat([header, nameBuf]);
  if (seg.length % 2 !== 0) seg = Buffer.concat([seg, Buffer.from([0x00])]);
  return seg;
}

/**
 * Build a CIP path from a symbolic variable name like "MyStruct.Member[3].Field".
 * Splits on `.`, `[`, `]`. Numeric tokens become 32-bit element segments; identifier
 * tokens become extended-symbol segments.
 *
 * @param {string} variableName
 * @returns {Buffer}
 */
function variableRequestPathSegment(variableName) {
  const tokens = variableName.split(/[\[\].]/).filter(Boolean);
  const parts = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const elementId = Buffer.alloc(4);
      elementId.writeUInt32LE(parseInt(token, 10), 0);
      parts.push(addressRequestPathSegment({ elementId }));
    } else {
      parts.push(_extendedSymbolSegment(token));
    }
  }
  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

module.exports = {
  addressRequestPathSegment,
  variableRequestPathSegment,
  _extendedSymbolSegment, // exported for tests
};
