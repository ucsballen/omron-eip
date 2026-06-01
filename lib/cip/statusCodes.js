'use strict';
/**
 * CIP general/extended status codes and CIPException.
 * Ported from aphyt/cip/cip.py.
 */

// Keys are hex strings (lowercase, no separator) for portable lookup,
// since Buffer can't be used as a Map key directly.
const CIP_STATUS = Object.freeze({
  '00': ['SUCCESS', ''],
  '02': ['RESOURCE_UNAVAILABLE',
    'Generally caused by too many concurrent requests exhausting PLC Ethernet/IP processing resources. ' +
    'Decrease concurrency (e.g. via a semaphore).'],
  '04': ['PATH_SEGMENT_ERROR',
    'Generally caused by the variable not existing or not being published in the global variable table.'],
  '05': ['PATH_DESTINATION_UNKNOWN', ''],
  '0c': ['OBJECT_STATE_CONFLICT', ''],
  '11': ['REPLY_DATA_TOO_LARGE', ''],
  '13': ['NOT_ENOUGH_DATA', ''],
  '15': ['TOO_MUCH_DATA', ''],
  '1f': ['VENDOR_SPECIFIC_ERROR', ''],
  '20': ['INVALID_PARAMETER', ''],
  '1080': ['Downloading, starting up', ''],
  '1180': ['There is an error in tag memory', ''],
  '02010421': ['An attempt was made to read an I/O variable that cannot be read', ''],
  '04010311': ['The specified address and size exceed a segment boundary', ''],
  '0180': ['An internal error occurred', ''],
  '0780': ['An inaccessible variable was specified', ''],
  '3180': ['An internal error occurred (memory allocation error)', ''],
  '02010321': ['An attempt was made to write a constant or read-only variable', ''],
  '2980': ['A region that all cannot be accessed at the same time was specified for SimpleDataSegment', ''],
  '0980': ['A segment type error occurred', ''],
  '0f80': ['There is an inconsistency in data length information in the Request Data', ''],
  '1780': ['More than one element was specified for a variable that does not have elements', ''],
  '1880': ['Zero elements or data that exceeded the range of the array was specified for an array', ''],
  '2180': ['A value other than 0 or 2 was specified for an AddInfo area', ''],
  '2280': ['The data type that is specified in the request service data does not agree with the tag information, ' +
          'or the AddInfo Length in the request service data is not 0', ''],
  '2380': ['An internal error occurred (illegal command format)', ''],
  '2480': ['An internal error occurred (illegal command length)', ''],
  '2580': ['An internal error occurred (illegal parameter)', ''],
  '2780': ['An internal error occurred (parameter error)', ''],
  '2880': ['An attempt was made to write an out-of-range value, or write an undefined value to an enumeration', ''],
});

class CIPException extends Error {
  /**
   * @param {Buffer} status         general status (1 byte)
   * @param {Buffer} extendedStatus extended status (0 or more bytes)
   */
  constructor(status, extendedStatus) {
    const key = status.toString('hex');
    const ext = extendedStatus.toString('hex');
    const generalEntry = CIP_STATUS[key] || ['UNKNOWN_STATUS', ''];
    let msg = `CIP reply general status 0x${key}: ${generalEntry[0]}`;
    if (generalEntry[1]) msg += ` — ${generalEntry[1]}`;
    if (ext) {
      msg += `\nExtended status 0x${ext}`;
      const extEntry = CIP_STATUS[ext];
      if (extEntry) msg += `: ${extEntry[0]}${extEntry[1] ? ' — ' + extEntry[1] : ''}`;
    }
    super(msg);
    this.name = 'CIPException';
    this.status = status;
    this.extendedStatus = extendedStatus;
    this.statusCode = key;
    this.extendedStatusCode = ext;
  }
}

module.exports = { CIP_STATUS, CIPException };
