'use strict';
/**
 * Omron-specific CIP reply wrappers. These extend the parsing of CIP reply data for the
 * Omron classes 0x6A (tag name server), 0x6B (variable object), and 0x6C (variable type object).
 *
 * Ported from aphyt n_series.py VariableObjectReply / VariableTypeObjectReply /
 * VariableNameAttributeAllReply / InstanceIDAttributes.
 */

/**
 * Reply from get_attribute_all on class 0x6C (Variable Type Object). Describes a derived
 * data type — structures, arrays, and the like.
 *
 * The layout below uses `replyData` offsets, with `arrayDimension` * 4 stretching the
 * middle of the structure to cover dimensional metadata.
 */
class VariableTypeObjectReply {
  constructor(cipReply) {
    this.cipReply = cipReply;
    this.replyData = cipReply.replyData;
  }

  get sizeInMemory()       { return this.replyData.readUInt32LE(0); }
  get size()               { return this.sizeInMemory; }
  get cipDataType()        { return this.replyData.subarray(5, 6); }
  get cipDataTypeOfArray() { return this.replyData.subarray(6, 7); }
  get arrayDimension()     { return this.replyData.readUInt8(7); }

  /** Per-dimension element counts. */
  get numberOfElements() {
    const list = [];
    for (let i = 0; i < this.arrayDimension; i++) {
      list.push(this.replyData.readUInt32LE(8 + i * 4));
    }
    return list;
  }

  get numberOfMembers() { return this.replyData.readUInt16LE(8 + this.arrayDimension * 4); }
  get crcCode()         { return this.replyData.readUInt16LE(14 + this.arrayDimension * 4); }
  get variableTypeNameLength() { return this.replyData.readUInt8(16 + this.arrayDimension * 4); }

  /** Padding so the variable name length lands on a word boundary. */
  get padding() { return this.variableTypeNameLength % 2 === 0 ? 1 : 0; }

  get variableTypeName() {
    const start = 17 + this.arrayDimension * 4;
    return this.replyData.subarray(start, start + this.variableTypeNameLength);
  }

  /** Instance ID of the next sibling member in a structure type definition. */
  get nextInstanceId() {
    const start = this.padding + 17 + this.arrayDimension * 4 + this.variableTypeNameLength;
    return this.replyData.subarray(start, start + 4);
  }

  /** Instance ID of the first nested member (e.g. for descending into a struct). */
  get nestingVariableTypeInstanceId() {
    const start = this.padding + 21 + this.arrayDimension * 4 + this.variableTypeNameLength;
    return this.replyData.subarray(start, start + 4);
  }

  /** First-element index in each dimension (Omron arrays may start from non-zero). */
  get startArrayElements() {
    const list = [];
    const start = this.padding + 25 + this.arrayDimension * 4 + this.variableTypeNameLength;
    for (let i = 0; i < this.arrayDimension; i++) {
      // NOTE: aphyt reads the same 4 bytes each iteration. Faithfully porting that.
      // Likely intended to advance: `start + i * 4`. Keep as-is to match Python behavior.
      list.push(this.replyData.readUInt32LE(start));
    }
    return list;
  }
}

/**
 * Reply from get_attribute_all on class 0x6B (Variable Object). Describes a single published
 * variable's basic attributes — its size, data type, and (for arrays) dimensions.
 */
class VariableObjectReply {
  constructor(cipReply) {
    this.cipReply = cipReply;
    this.replyData = cipReply.replyData;
  }

  get size()               { return this.replyData.readUInt32LE(0); }
  get cipDataType()        { return this.replyData.subarray(4, 5); }
  get cipDataTypeOfArray() { return this.replyData.subarray(5, 6); }
  /** 1 byte of padding follows the array dimension; data resumes at offset 8. */
  get arrayDimension()     { return this.replyData.readUInt8(6); }

  get numberOfElements() {
    const list = [];
    for (let i = 0; i < this.arrayDimension; i++) {
      list.push(this.replyData.readUInt32LE(8 + i * 4));
    }
    return list;
  }

  get bitNumber() { return this.replyData.readUInt8(16 + this.arrayDimension * 4); }
  get variableTypeInstanceId() {
    const start = 20 + this.arrayDimension * 4;
    return this.replyData.subarray(start, start + 4);
  }

  get startArrayElements() {
    const list = [];
    const start = 24 + this.arrayDimension * 4;
    for (let i = 0; i < this.arrayDimension; i++) {
      // Same observation as VariableTypeObjectReply: aphyt repeats the same offset.
      list.push(this.replyData.readUInt32LE(start));
    }
    return list;
  }
}

/** Reply from get_attribute_all on a tag — gives the data type + variable_type instance id. */
class VariableNameAttributeAllReply {
  constructor(cipReply) {
    this.cipReply = cipReply;
    this.replyData = cipReply.replyData;
  }
  get cipDataType()        { return this.replyData.subarray(4, 5); }
  get instanceId()         { return this.replyData.subarray(8, 12); }
  get variableTypeId()     { return this.replyData.subarray(12, 16); }
}

/** Per-instance attribute record returned in the get_instance_list_ex2 reply. */
class InstanceIDAttributes {
  /** @param {Buffer} data */
  constructor(data) { this.data = data; }
  get dataLength() { return this.data.readUInt16LE(0); }
  get classId()    { return this.data.subarray(2, 4); }
  get instanceId() { return this.data.subarray(4, 8); }
  tagNameLength()  { return this.data.readUInt8(8); }
  tagName()        { return this.data.subarray(9, 9 + this.tagNameLength()).toString('utf8'); }
}

module.exports = {
  VariableTypeObjectReply,
  VariableObjectReply,
  VariableNameAttributeAllReply,
  InstanceIDAttributes,
};
