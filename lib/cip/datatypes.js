'use strict';
/**
 * CIP data type classes.
 *
 * Each subclass exposes:
 *   static dataTypeCode  → Buffer(1)  — the CIP type code
 *   instance.data        → Buffer     — the wire bytes
 *   instance.size        → number     — byte length on the wire
 *   instance.alignment   → number     — alignment in bytes
 *   instance.value()                  → unwrapped JS value
 *   instance.fromValue(v)             → set the wire bytes from a JS value
 *   instance.bytes()                  → CIP-common-format wrapper (type code + addl info + data)
 *   instance.fromBytes(buf)           → parse a CIP-common-format wrapper
 *
 * Types are auto-registered via registerType() in a module-level Map (keyed by type-code hex).
 * Equivalent to Python's CIPDataType.__subclasses__() walk in update_data_type_dictionary().
 */

// ------------------------------ registry ------------------------------

const DATA_TYPE_REGISTRY = new Map(); // hex-of-type-code -> class

function registerType(cls) {
  if (!cls.dataTypeCode || !Buffer.isBuffer(cls.dataTypeCode)) {
    throw new Error(`${cls.name}: dataTypeCode must be a static Buffer`);
  }
  DATA_TYPE_REGISTRY.set(cls.dataTypeCode.toString('hex'), cls);
  return cls;
}

/** Look up a data type class by its 1-byte code Buffer (or hex string). */
function getDataTypeClass(code) {
  const key = Buffer.isBuffer(code) ? code.toString('hex') : String(code).toLowerCase();
  return DATA_TYPE_REGISTRY.get(key) || null;
}

/** Instantiate a type from its code. Returns null if unknown. */
function createTypeInstance(code) {
  const cls = getDataTypeClass(code);
  return cls ? new cls() : null;
}

// ------------------------------ base class ------------------------------

/**
 * Type-validation helpers used in fromValue() to surface clear errors instead of
 * the cryptic Buffer.write*LE messages you get when passing the wrong shape.
 *
 *   _expectIntInRange('CIPInteger', v, -32768, 32767)
 *   _expectFinite('CIPReal', v)
 *   _expectBigOrInt('CIPLongInteger', v, -2n**63n, 2n**63n - 1n)
 *   _expectString('CIPString', v)
 *   _expectBuffer('CIPByte', v)
 *   _expectArray('CIPArray', v)
 *   _expectPlainObject('CIPStructure', v)
 */
function _expectIntInRange(name, v, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new TypeError(`${name}.fromValue: expected an integer Number, got ${_describe(v)}`);
  }
  if (v < min || v > max) {
    throw new RangeError(`${name}.fromValue: value ${v} out of range [${min}, ${max}]`);
  }
}
function _expectFinite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${name}.fromValue: expected a finite Number, got ${_describe(v)}`);
  }
}
function _expectBigOrInt(name, v, min, max) {
  let big;
  if (typeof v === 'bigint') big = v;
  else if (typeof v === 'number' && Number.isInteger(v)) big = BigInt(v);
  else throw new TypeError(`${name}.fromValue: expected BigInt or integer Number, got ${_describe(v)}`);
  if (big < min || big > max) {
    throw new RangeError(`${name}.fromValue: value ${big} out of range [${min}, ${max}]`);
  }
  return big;
}
function _expectString(name, v) {
  if (typeof v !== 'string') {
    throw new TypeError(`${name}.fromValue: expected a string, got ${_describe(v)}`);
  }
}
function _expectBuffer(name, v) {
  if (!Buffer.isBuffer(v)) {
    throw new TypeError(`${name}.fromValue: expected a Buffer, got ${_describe(v)}`);
  }
}
function _expectArray(name, v) {
  if (!Array.isArray(v)) {
    throw new TypeError(`${name}.fromValue: expected an Array, got ${_describe(v)}`);
  }
}
function _expectPlainObject(name, v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v)) {
    throw new TypeError(`${name}.fromValue: expected a plain object, got ${_describe(v)}`);
  }
}
function _describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'Array';
  if (Buffer.isBuffer(v)) return 'Buffer';
  if (typeof v === 'object') return v.constructor ? v.constructor.name : 'object';
  return typeof v;
}

class CIPDataType {
  constructor() {
    this._dataTypeCode = this.constructor.dataTypeCode;
    this.additionalInfoLength = 0;
    this.additionalInfo = Buffer.alloc(0);
    this.data = Buffer.alloc(0);
    this.size = 0;
    this.instanceId = null;
    this.variableName = '';
  }
  /** Most types align to their on-wire size; overridden by strings, structures, arrays. */
  get alignment() { return this.size; }

  /** Serialize as CIP common-format: type code + addl-info-length + addl-info + data. */
  bytes() {
    return Buffer.concat([
      this.constructor.dataTypeCode,
      Buffer.from([this.additionalInfoLength]),
      this.additionalInfo,
      this.data,
    ]);
  }

  /** Parse a CIP common-format byte stream into this instance. */
  fromBytes(buf) {
    this._dataTypeCode = buf.subarray(0, 1);
    this.additionalInfoLength = buf.readUInt8(1);
    this.additionalInfo = buf.subarray(2, 2 + this.additionalInfoLength);
    this.data = buf.subarray(2 + this.additionalInfoLength);
    this.size = this.data.length;
  }

  value() { throw new Error('subclass must implement value()'); }
  fromValue(_v) { throw new Error('subclass must implement fromValue()'); }
}

// ------------------------------ scalar types ------------------------------

class CIPBoolean extends CIPDataType {
  static dataTypeCode = Buffer.from([0xc1]);
  constructor() { super(); this.data = Buffer.alloc(2); this.size = 2; }
  value() { return this.data.readUInt16LE(0) !== 0; }
  fromValue(v) {
    this.data = Buffer.alloc(2);
    this.data.writeUInt16LE(v ? 1 : 0, 0);
  }
}
registerType(CIPBoolean);

class CIPShortInteger extends CIPDataType { // SINT
  static dataTypeCode = Buffer.from([0xc2]);
  constructor() { super(); this.data = Buffer.alloc(1); this.size = 1; }
  value() { return this.data.readInt8(0); }
  fromValue(v) {
    _expectIntInRange('CIPShortInteger', v, -128, 127);
    this.data = Buffer.alloc(1); this.data.writeInt8(v, 0);
  }
}
registerType(CIPShortInteger);

class CIPInteger extends CIPDataType { // INT
  static dataTypeCode = Buffer.from([0xc3]);
  constructor() { super(); this.data = Buffer.alloc(2); this.size = 2; }
  value() { return this.data.readInt16LE(0); }
  fromValue(v) {
    _expectIntInRange('CIPInteger', v, -32768, 32767);
    this.data = Buffer.alloc(2); this.data.writeInt16LE(v, 0);
  }
}
registerType(CIPInteger);

class CIPDoubleInteger extends CIPDataType { // DINT
  static dataTypeCode = Buffer.from([0xc4]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data.readInt32LE(0); }
  fromValue(v) {
    _expectIntInRange('CIPDoubleInteger', v, -2147483648, 2147483647);
    this.data = Buffer.alloc(4); this.data.writeInt32LE(v, 0);
  }
}
registerType(CIPDoubleInteger);

class CIPLongInteger extends CIPDataType { // LINT
  static dataTypeCode = Buffer.from([0xc5]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data.readBigInt64LE(0); }
  fromValue(v) {
    const big = _expectBigOrInt('CIPLongInteger', v, -(2n ** 63n), 2n ** 63n - 1n);
    this.data = Buffer.alloc(8); this.data.writeBigInt64LE(big, 0);
  }
}
registerType(CIPLongInteger);

class CIPUnsignedShortInteger extends CIPDataType { // USINT
  static dataTypeCode = Buffer.from([0xc6]);
  constructor() { super(); this.data = Buffer.alloc(1); this.size = 1; }
  value() { return this.data.readUInt8(0); }
  fromValue(v) {
    _expectIntInRange('CIPUnsignedShortInteger', v, 0, 255);
    this.data = Buffer.alloc(1); this.data.writeUInt8(v, 0);
  }
}
registerType(CIPUnsignedShortInteger);

class CIPUnsignedInteger extends CIPDataType { // UINT
  static dataTypeCode = Buffer.from([0xc7]);
  constructor() { super(); this.data = Buffer.alloc(2); this.size = 2; }
  value() { return this.data.readUInt16LE(0); }
  fromValue(v) {
    _expectIntInRange('CIPUnsignedInteger', v, 0, 65535);
    this.data = Buffer.alloc(2); this.data.writeUInt16LE(v, 0);
  }
}
registerType(CIPUnsignedInteger);

class CIPUnsignedDoubleInteger extends CIPDataType { // UDINT
  static dataTypeCode = Buffer.from([0xc8]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data.readUInt32LE(0); }
  fromValue(v) {
    _expectIntInRange('CIPUnsignedDoubleInteger', v, 0, 4294967295);
    this.data = Buffer.alloc(4); this.data.writeUInt32LE(v, 0);
  }
}
registerType(CIPUnsignedDoubleInteger);

class CIPUnsignedLongInteger extends CIPDataType { // ULINT
  static dataTypeCode = Buffer.from([0xc9]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data.readBigUInt64LE(0); }
  fromValue(v) {
    const big = _expectBigOrInt('CIPUnsignedLongInteger', v, 0n, 2n ** 64n - 1n);
    this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(big, 0);
  }
}
registerType(CIPUnsignedLongInteger);

class CIPReal extends CIPDataType { // REAL
  static dataTypeCode = Buffer.from([0xca]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data.readFloatLE(0); }
  fromValue(v) {
    _expectFinite('CIPReal', v);
    this.data = Buffer.alloc(4); this.data.writeFloatLE(v, 0);
  }
}
registerType(CIPReal);

class CIPLongReal extends CIPDataType { // LREAL
  static dataTypeCode = Buffer.from([0xcb]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data.readDoubleLE(0); }
  fromValue(v) {
    _expectFinite('CIPLongReal', v);
    this.data = Buffer.alloc(8); this.data.writeDoubleLE(v, 0);
  }
}
registerType(CIPLongReal);

// ------------------------------ string ------------------------------

class CIPString extends CIPDataType {
  static dataTypeCode = Buffer.from([0xd0]);
  constructor() { super(); this.data = Buffer.alloc(0); this.size = 0; }
  /** Strings have byte-level alignment (1) — different from their size. */
  get alignment() { return 0; }

  value() {
    const nul = this.data.indexOf(0);
    const end = nul === -1 ? this.data.length : nul;
    return this.data.subarray(0, end).toString('utf8');
  }
  fromValue(v) {
    _expectString('CIPString', v);
    const enc = Buffer.from(v, 'utf8');
    if (this.size === 0) {
      this.data = enc;
      this.size = enc.length;
    } else {
      const out = Buffer.alloc(this.size); // null-padded to declared size
      enc.copy(out, 0, 0, Math.min(enc.length, this.size));
      this.data = out;
    }
  }
}
registerType(CIPString);

// ------------------------------ raw bit-bag types ------------------------------

class CIPByte extends CIPDataType {
  static dataTypeCode = Buffer.from([0xd1]);
  constructor() { super(); this.data = Buffer.alloc(1); this.size = 1; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from([v & 0xff]); }
}
registerType(CIPByte);

class CIPWord extends CIPDataType {
  static dataTypeCode = Buffer.from([0xd2]);
  constructor() { super(); this.data = Buffer.alloc(2); this.size = 2; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(CIPWord);

class CIPDoubleWord extends CIPDataType {
  static dataTypeCode = Buffer.from([0xd3]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(CIPDoubleWord);

class CIPLongWord extends CIPDataType {
  static dataTypeCode = Buffer.from([0xd4]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(CIPLongWord);

class CIPTime extends CIPDataType {
  static dataTypeCode = Buffer.from([0xdb]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(CIPTime);

// ------------------------------ Omron-specific types ------------------------------
// NX/NJ controllers publish several Omron-specific CIP type codes (0x04–0x0c) in addition
// to the standard CIP elementary types. Ported from aphyt's omron_datatypes.py. These show
// up when enumerating the variable dictionary (e.g. an enum variable is 0x07). Without them,
// updateVariableDictionary() would skip those variables.

// 0x07 — Omron ENUM: a 4-byte enumeration, read as an unsigned 32-bit integer.
class OmronEnum extends CIPDataType {
  static dataTypeCode = Buffer.from([0x07]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data.readUInt32LE(0); }
  fromValue(v) {
    _expectIntInRange('OmronEnum', v, 0, 4294967295);
    this.data = Buffer.alloc(4); this.data.writeUInt32LE(v, 0);
  }
}
registerType(OmronEnum);

// 0x09 — Omron TIME (nanoseconds, 8-byte). Read as a BigInt of nanoseconds.
class OmronTime extends CIPDataType {
  static dataTypeCode = Buffer.from([0x09]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data.readBigInt64LE(0); }
  fromValue(v) {
    const big = _expectBigOrInt('OmronTime', v, -(2n ** 63n), 2n ** 63n - 1n);
    this.data = Buffer.alloc(8); this.data.writeBigInt64LE(big, 0);
  }
}
registerType(OmronTime);

// 0x0a — Omron DATE_AND_TIME (nanoseconds since epoch, 8-byte). Read as a JS Date.
class OmronDateAndTime extends CIPDataType {
  static dataTypeCode = Buffer.from([0x0a]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() {
    const ns = this.data.readBigUInt64LE(0);
    return new Date(Number(ns / 1000000n));   // ns -> ms
  }
  fromValue(v) {
    if (v instanceof Date) {
      const ns = BigInt(v.getTime()) * 1000000n;
      this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(ns, 0);
    } else {
      const big = _expectBigOrInt('OmronDateAndTime', v, 0n, 2n ** 64n - 1n);
      this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(big, 0);
    }
  }
}
registerType(OmronDateAndTime);

// 0x0b — Omron TIME_OF_DAY (nanoseconds, 8-byte). Read as a BigInt of nanoseconds.
class OmronTimeOfDay extends CIPDataType {
  static dataTypeCode = Buffer.from([0x0b]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data.readBigUInt64LE(0); }
  fromValue(v) {
    const big = _expectBigOrInt('OmronTimeOfDay', v, 0n, 2n ** 64n - 1n);
    this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(big, 0);
  }
}
registerType(OmronTimeOfDay);

// 0x08 — Omron DATE (nanoseconds, 8-byte). Read as a JS Date.
class OmronDate extends CIPDataType {
  static dataTypeCode = Buffer.from([0x08]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() {
    const ns = this.data.readBigUInt64LE(0);
    return new Date(Number(ns / 1000000n));
  }
  fromValue(v) {
    if (v instanceof Date) {
      const ns = BigInt(v.getTime()) * 1000000n;
      this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(ns, 0);
    } else {
      const big = _expectBigOrInt('OmronDate', v, 0n, 2n ** 64n - 1n);
      this.data = Buffer.alloc(8); this.data.writeBigUInt64LE(big, 0);
    }
  }
}
registerType(OmronDate);

// 0x0c — Omron UNION. Layout is type-specific; expose the raw bytes (round-trips correctly).
class OmronUnion extends CIPDataType {
  static dataTypeCode = Buffer.from([0x0c]);
  constructor() { super(); this.data = Buffer.alloc(0); this.size = 0; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(OmronUnion);

// 0x04 / 0x05 / 0x06 — Omron BCD (unsigned, 1/2/4 word). Rare; expose raw bytes.
class OmronUintBCD extends CIPDataType {
  static dataTypeCode = Buffer.from([0x04]);
  constructor() { super(); this.data = Buffer.alloc(2); this.size = 2; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(OmronUintBCD);

class OmronUdintBCD extends CIPDataType {
  static dataTypeCode = Buffer.from([0x05]);
  constructor() { super(); this.data = Buffer.alloc(4); this.size = 4; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(OmronUdintBCD);

class OmronUlintBCD extends CIPDataType {
  static dataTypeCode = Buffer.from([0x06]);
  constructor() { super(); this.data = Buffer.alloc(8); this.size = 8; }
  value() { return this.data; }
  fromValue(v) { this.data = Buffer.isBuffer(v) ? v : Buffer.from(v); }
}
registerType(OmronUlintBCD);


// ------------------------------ abbreviated struct & struct ------------------------------

class CIPAbbreviatedStructure extends CIPDataType {
  static dataTypeCode = Buffer.from([0xa0]);
  constructor() { super(); }
  value() { return this.data; }
  fromValue(v) { this.data = v; }
}
registerType(CIPAbbreviatedStructure);

/**
 * CIPStructure carries an ordered map of named members. value() returns a plain JS object
 * (recursive); fromValue() accepts a plain JS object and re-packs member bytes into `this.data`.
 *
 * Member byte layout follows the Python port's alignment rules:
 *   - if member.alignment > 0 and offset % alignment != 0, pad offset up to the alignment
 *   - else if the previous member's type differs and offset is odd, bump offset by 1 (word-align)
 */
class CIPStructure extends CIPDataType {
  static dataTypeCode = Buffer.from([0xa2]);
  constructor() {
    super();
    this.variableTypeName = '';
    /** @type {Map<string, CIPDataType>} */
    this.members = new Map();
    this._alignment = 0;
    this.crcCode = Buffer.alloc(0);
    // Used by nested-structure construction so a child's fromValue propagates up to parent's data.
    this._parentCallback = null;
    // Whether the local byte-packing layout (value()/fromValue()) matches the controller's
    // actual memory layout. True for Sysmac "NJ" offset-type structs, where members are laid
    // out by the same rules this class computes. Set false for "User" offset-type structs,
    // whose hand-placed / bit-packed members the byte-granular packer can't reproduce — those
    // are read/written member-by-member via symbolic paths instead (see NSeries). Default true
    // so any structure built without an explicit decision behaves exactly as before.
    this._layoutTrusted = true;
  }

  get alignment() { return this._alignment; }
  set alignment(v) { this._alignment = v; }

  addMember(name, member) {
    this.members.set(name, member);
    if (member.alignment > this._alignment) this._alignment = member.alignment;
  }

  /**
   * Slice this.data into per-member buffers, recurse into nested structures, and return a plain
   * JS object of member-name → unwrapped-value.
   */
  value() {
    const out = {};
    let offset = 0;
    let prevType = null;
    for (const [name, member] of this.members) {
      if (member.alignment !== 0 && offset % member.alignment !== 0) {
        offset += member.alignment - (offset % member.alignment);
      } else if (prevType !== null && prevType !== member.constructor && offset % 2 !== 0) {
        offset += 1;
      }
      const end = offset + member.size;
      member.data = this.data.subarray(offset, end);
      out[name] = member.value();
      prevType = member.constructor;
      offset = end;
    }
    return out;
  }

  /**
   * Accepts EITHER a plain JS object (preferred public API) OR another CIPStructure (used
   * internally when reflecting member changes back up the tree).
   */
  fromValue(v) {
    let offset = 0;
    let prevType = null;
    const out = Buffer.alloc(Math.max(this.size, this.data.length));

    if (v instanceof CIPStructure) {
      // Internal: copy member.data through verbatim, recomputing layout.
      this.crcCode = v.crcCode;
      for (const [, member] of v.members) {
        ({ offset, prevType } = this._padOffset(offset, prevType, member));
        member.data.copy(out, offset, 0, member.size);
        prevType = member.constructor;
        offset += member.size;
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
      // Public: object of name → value; push into each member and serialize.
      for (const [name, member] of this.members) {
        ({ offset, prevType } = this._padOffset(offset, prevType, member));
        if (name in v) member.fromValue(v[name]);
        member.data.copy(out, offset, 0, member.size);
        prevType = member.constructor;
        offset += member.size;
      }
    } else {
      _expectPlainObject('CIPStructure', v);
    }

    this.data = out.subarray(0, offset);
    if (this._parentCallback) this._parentCallback();
  }

  _padOffset(offset, prevType, member) {
    if (member.alignment !== 0 && offset % member.alignment !== 0) {
      offset += member.alignment - (offset % member.alignment);
    } else if (prevType !== null && prevType !== member.constructor && offset % 2 !== 0) {
      offset += 1;
    }
    return { offset, prevType };
  }

  /**
   * Total byte size this structure would occupy under the local byte-packing rules — i.e.
   * exactly where value()/fromValue() would place the end of the last member. Compared
   * against the controller's reported sizeInMemory to decide whether the local layout can
   * be trusted (see NSeries._structureInstanceFromVariableTypeObject). Mirrors the offset
   * progression in value() precisely.
   */
  computePackedSize() {
    let offset = 0;
    let prevType = null;
    for (const [, member] of this.members) {
      if (member.alignment !== 0 && offset % member.alignment !== 0) {
        offset += member.alignment - (offset % member.alignment);
      } else if (prevType !== null && prevType !== member.constructor && offset % 2 !== 0) {
        offset += 1;
      }
      offset += member.size;
      prevType = member.constructor;
    }
    return offset;
  }
}
registerType(CIPStructure);

// ------------------------------ array ------------------------------

/**
 * Multi-dimensional CIP array. Element type is held as a "prototype" instance (this._elemProto)
 * that gets its `.data` reassigned for each cell during marshalling. Boolean arrays are bit-packed
 * 16 bits per word (matching CIP/Omron behavior).
 *
 * Public API:
 *   from a primitive element type: arr.fromItems(typeCode, elemSize, ndim, [counts...], [starts...])
 *   from a derived element type (e.g. nested struct): arr.fromInstance(elemProto, elemSize, ndim, [counts...], [starts...])
 *   arr.value()        → nested JS array of plain values
 *   arr.fromValue(v)   → accepts nested JS array, packs into this.data
 */
class CIPArray extends CIPDataType {
  static dataTypeCode = Buffer.from([0xa3]);
  constructor() {
    super();
    this.arrayDataType = Buffer.alloc(0);
    this.arrayDataTypeSize = 0;
    this.memberInstanceId = null;
    this.arrayDimensions = 0;
    this.numberOfElements = [];
    this.startArrayElements = [];
    this.size = 0;
    this._elemProto = null;
    this._alignment = 0;
    this.data = Buffer.alloc(0);
  }

  get alignment() { return this._alignment; }

  _computeSize() {
    let total = 1;
    let last = 0;
    for (const n of this.numberOfElements) { total *= n; last = n; }
    if (this.arrayDataType.equals(CIPBoolean.dataTypeCode)) {
      // BOOL arrays are bit-packed and rounded up to whole 16-bit words. The previous
      // formula (floor(total/8) + 2-if-not-16-multiple) conflated /8 and /16 and was off
      // by a byte for non-16-multiple counts (e.g. 12 bools reported 3, controller says 2).
      total = Math.ceil(total / 16) * 2;
      void last;
    } else {
      total *= this.arrayDataTypeSize;
    }
    return total;
  }

  fromItems(arrayDataType, arrayDataSize, ndim, counts, starts) {
    this.arrayDataType = arrayDataType;
    this.arrayDataTypeSize = arrayDataSize;
    this.arrayDimensions = ndim;
    this.numberOfElements = counts;
    this.startArrayElements = starts;
    this.size = this._computeSize();
    this._elemProto = createTypeInstance(arrayDataType);
    if (this.data.length === 0) this.data = Buffer.alloc(this.size);
    this._alignment = this._elemProto ? this._elemProto.alignment : 0;
  }

  fromInstance(elemInstance, arrayDataSize, ndim, counts, starts) {
    this.arrayDataType = elemInstance.constructor.dataTypeCode;
    this.memberInstanceId = elemInstance.instanceId;
    this.arrayDataTypeSize = arrayDataSize;
    this.arrayDimensions = ndim;
    this.numberOfElements = counts;
    this.startArrayElements = starts;
    this.size = this._computeSize();
    this._elemProto = elemInstance;
    if (this.data.length === 0) this.data = Buffer.alloc(this.size);
    this._alignment = elemInstance.alignment;
  }

  /** Recursive bytes -> nested JS array. */
  _toArray(dim = 0, position = 0) {
    const isBool = this.arrayDataType.equals(CIPBoolean.dataTypeCode);
    if (dim === this.arrayDimensions - 1) {
      const out = [];
      for (let i = 0; i < this.numberOfElements[dim]; i++) {
        if (isBool) {
          const bit = position + i;
          const byteOffset = Math.floor(bit / 8);
          const bitOffset = bit % 8;
          out.push((this.data[byteOffset] & (1 << bitOffset)) !== 0);
        } else {
          const start = (position + i) * this.arrayDataTypeSize;
          this._elemProto.data = this.data.subarray(start, start + this.arrayDataTypeSize);
          // deep-extract: for primitives this is the scalar; for structures it's a plain object.
          out.push(this._cloneValue(this._elemProto.value()));
        }
      }
      return out;
    }
    let elementsPerIndex = 1;
    for (let d = dim + 1; d < this.arrayDimensions; d++) elementsPerIndex *= this.numberOfElements[d];
    const out = [];
    for (let i = 0; i < this.numberOfElements[dim]; i++) {
      out.push(this._toArray(dim + 1, position + elementsPerIndex * i));
    }
    return out;
  }

  /** Cheap deep clone for the array's per-cell values so they don't alias the prototype. */
  _cloneValue(v) {
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (Array.isArray(v))   return v.map(x => this._cloneValue(x));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = this._cloneValue(v[k]);
      return o;
    }
    return v;
  }

  /** Recursive nested JS array -> bytes. */
  _toBytes(dim, list) {
    if (dim === 1) {
      const parts = [];
      for (const el of list) {
        this._elemProto.fromValue(el);
        parts.push(Buffer.from(this._elemProto.data));
      }
      return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
    }
    const parts = [];
    for (const sub of list) parts.push(this._toBytes(dim - 1, sub));
    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  }

  value() { return this._toArray(); }

  fromValue(v) {
    _expectArray('CIPArray', v);
    if (this.arrayDataType.equals(CIPBoolean.dataTypeCode)) {
      const flat = [];
      const flatten = arr => arr.forEach(x => Array.isArray(x) ? flatten(x) : flat.push(x));
      flatten(v);
      const buf = Buffer.alloc(this.size);
      flat.forEach((bit, i) => {
        if (bit) buf[Math.floor(i / 8)] |= 1 << (i % 8);
      });
      this.data = buf;
    } else {
      this.data = this._toBytes(this.arrayDimensions, v);
    }
  }
}
registerType(CIPArray);

// ------------------------------ exports ------------------------------

module.exports = {
  CIPDataType,
  CIPBoolean,
  CIPShortInteger,
  CIPInteger,
  CIPDoubleInteger,
  CIPLongInteger,
  CIPUnsignedShortInteger,
  CIPUnsignedInteger,
  CIPUnsignedDoubleInteger,
  CIPUnsignedLongInteger,
  CIPReal,
  CIPLongReal,
  CIPString,
  CIPByte,
  CIPWord,
  CIPDoubleWord,
  CIPLongWord,
  CIPTime,
  OmronEnum,
  OmronTime,
  OmronDateAndTime,
  OmronTimeOfDay,
  OmronDate,
  OmronUnion,
  OmronUintBCD,
  OmronUdintBCD,
  OmronUlintBCD,
  CIPAbbreviatedStructure,
  CIPStructure,
  CIPArray,
  DATA_TYPE_REGISTRY,
  registerType,
  getDataTypeClass,
  createTypeInstance,
};
