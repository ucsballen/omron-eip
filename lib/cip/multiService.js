'use strict';
/**
 * Multiple Service Packet (CIP service 0x0A).
 *
 * Pack N independent CIPRequests into one request, sent to the Message Router
 * (class 0x02, instance 1). The PLC executes each and returns one combined reply
 * containing N CIPReplies (each with its own general_status). Useful for reading
 * many unrelated scalars in one round-trip.
 *
 * NOT all Omron firmware versions support this; the NSeries layer probes support
 * at first use and falls back to concurrent individual requests if rejected with
 * SERVICE_NOT_SUPPORTED (0x08) or similar.
 *
 * Request body wire format (after the 0x0A service byte and standard CIP path):
 *   [number_of_services]      uint16 LE
 *   [offset_to_service_1]     uint16 LE   (relative to start of this body)
 *   [offset_to_service_2]     uint16 LE
 *   ...
 *   [offset_to_service_N]     uint16 LE
 *   [service 1 bytes]         (a full CIPRequest, service+path_size+path+data)
 *   [service 2 bytes]
 *   ...
 *
 * Reply body wire format (after the 0x8A reply service byte and status):
 *   [number_of_services]      uint16 LE
 *   [offset_to_reply_1]       uint16 LE
 *   ...
 *   [reply 1 bytes]           (a full CIPReply)
 *   ...
 */

const { CIPRequest, CIPReply, CIPService } = require('./framing');
const { addressRequestPathSegment } = require('./path');

/** Path to the Message Router used as the target of the Multiple Service Packet. */
const MESSAGE_ROUTER_PATH = addressRequestPathSegment({
  classId: Buffer.from([0x02]),
  instanceId: Buffer.from([0x01]),
});

/**
 * Build the request body that goes inside the wrapping CIPRequest.
 * @param {CIPRequest[]} requests
 * @returns {Buffer} the encoded body
 */
function encodeMultipleServiceBody(requests) {
  if (requests.length === 0) throw new Error('encodeMultipleServiceBody: empty request list');
  const serviceBufs = requests.map(r => r.bytes);

  // Offsets are uint16, relative to the start of this body (after the count word).
  // Layout: count(2) + offsets(2*N) + services...
  const offsetTableSize = 2 + 2 * requests.length;
  const offsets = [];
  let pos = offsetTableSize;
  for (const buf of serviceBufs) {
    offsets.push(pos);
    pos += buf.length;
  }

  const out = Buffer.alloc(pos);
  out.writeUInt16LE(requests.length, 0);
  for (let i = 0; i < offsets.length; i++) {
    out.writeUInt16LE(offsets[i], 2 + i * 2);
  }
  let write = offsetTableSize;
  for (const buf of serviceBufs) {
    buf.copy(out, write);
    write += buf.length;
  }
  return out;
}

/**
 * Build a wrapping CIPRequest that carries the Multiple Service Packet.
 * @param {CIPRequest[]} requests
 * @returns {CIPRequest}
 */
function buildMultipleServiceRequest(requests) {
  const body = encodeMultipleServiceBody(requests);
  return new CIPRequest(CIPService.MULTIPLE_SERVICE_PACKET, MESSAGE_ROUTER_PATH, body);
}

/**
 * Decode the reply_data of a Multiple Service Packet reply into N CIPReplies.
 * Each CIPReply has its own general_status — caller decides what to do with errors.
 *
 * @param {Buffer} replyData  the reply_data field of the outer CIPReply
 * @returns {CIPReply[]}
 */
function decodeMultipleServiceReply(replyData) {
  if (replyData.length < 2) throw new Error('decodeMultipleServiceReply: reply too short');
  const count = replyData.readUInt16LE(0);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(replyData.readUInt16LE(2 + i * 2));
  }
  const replies = [];
  for (let i = 0; i < count; i++) {
    const start = offsets[i];
    const end = (i + 1 < count) ? offsets[i + 1] : replyData.length;
    replies.push(new CIPReply(replyData.subarray(start, end)));
  }
  return replies;
}

module.exports = {
  MESSAGE_ROUTER_PATH,
  encodeMultipleServiceBody,
  buildMultipleServiceRequest,
  decodeMultipleServiceReply,
};
