'use strict';
/**
 * CIP framing: request, reply, common-format wrapper, and service-code constants.
 * Ported from aphyt cip.py.
 */

const CIPService = Object.freeze({
  READ_TAG_SERVICE:            Buffer.from([0x4c]),
  READ_TAG_FRAGMENTED_SERVICE: Buffer.from([0x52]),
  WRITE_TAG_SERVICE:           Buffer.from([0x4d]),
  WRITE_TAG_FRAGMENTED_SERVICE:Buffer.from([0x53]),
  READ_MODIFY_WRITE_TAG_SERVICE:Buffer.from([0x4e]),
  GET_ATTRIBUTE_ALL:           Buffer.from([0x01]),
  GET_ATTRIBUTE_SINGLE:        Buffer.from([0x0e]),
  RESET:                       Buffer.from([0x05]),
  SET_ATTRIBUTE_SINGLE:        Buffer.from([0x10]),
  GET_INSTANCE_LIST_EX2:       Buffer.from([0x5f]),
  MULTIPLE_SERVICE_PACKET:     Buffer.from([0x0a]),
});

/**
 * Assemble a CIP request:
 *   request_service (1) + path_size_in_words (1) + request_path + request_data
 */
class CIPRequest {
  /**
   * @param {Buffer} service 1-byte service code
   * @param {Buffer} path    request path (must be even length)
   * @param {Buffer} [data]  request data payload
   */
  constructor(service, path, data = Buffer.alloc(0)) {
    if (path.length % 2 !== 0) {
      throw new Error(`CIPRequest path must be word-aligned (even bytes), got ${path.length}`);
    }
    this.service = service;
    this.path = path;
    this.data = data;
    this.pathSize = path.length / 2; // size in 16-bit words
  }

  get bytes() {
    return Buffer.concat([
      this.service,
      Buffer.from([this.pathSize]),
      this.path,
      this.data,
    ]);
  }
}

/**
 * Parse a CIP reply:
 *   reply_service (1) + reserved (1) + general_status (1) + ext_status_size (1, in words) +
 *   extended_status + reply_data
 */
class CIPReply {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.replyService    = buf.subarray(0, 1);
    this.reserved        = buf.subarray(1, 2);
    this.generalStatus   = buf.subarray(2, 3);
    this.extendedStatusSize = buf.subarray(3, 4);
    const extBytes = buf.readUInt8(3) * 2; // size is in words
    this.extendedStatus = buf.subarray(4, 4 + extBytes);
    this.replyData      = buf.subarray(4 + extBytes);
    this._raw           = buf;
  }
  get bytes() { return this._raw; }
}

/**
 * The "common format" wrapper used inside read/write_tag request data and reply data:
 *   data_type (1) + additional_info_length (1) + additional_info + data
 */
class CIPCommonFormat {
  constructor({ dataType = Buffer.alloc(0), additionalInfoLength = 0,
                additionalInfo = Buffer.alloc(0), data = Buffer.alloc(0) } = {}) {
    this.dataType = dataType;
    this.additionalInfoLength = additionalInfoLength;
    this.additionalInfo = additionalInfo;
    this.data = data;
  }

  static fromBytes(buf) {
    const dataType = buf.subarray(0, 1);
    const addlLen = buf.readUInt8(1);
    const addlInfo = buf.subarray(2, 2 + addlLen);
    const data = buf.subarray(2 + addlLen);
    return new CIPCommonFormat({
      dataType,
      additionalInfoLength: addlLen,
      additionalInfo: addlInfo,
      data,
    });
  }
}

module.exports = { CIPService, CIPRequest, CIPReply, CIPCommonFormat };
