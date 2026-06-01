'use strict';
/**
 * EIP device discovery via UDP broadcast.
 *
 * The List Identity command (0x63) also works over UDP on port 44818, and every EIP
 * device on the subnet that hears a broadcast replies with its identity. We collect
 * responses for a fixed window, parse them, and return the list.
 *
 * Useful for commissioning UIs ("find my PLC") or for Node-RED nodes that want to
 * present a dropdown of available controllers.
 *
 * Usage:
 *   const { discoverDevices } = require('omron-eip');
 *   const devices = await discoverDevices({ timeoutMs: 2000 });
 *   for (const d of devices) console.log(d.ip, d.productName);
 */

const dgram = require('dgram');
const { EIPMessage, CommonPacketFormat } = require('./messages');

const EIP_PORT = 44818;

/**
 * Broadcast a List Identity request and collect replies.
 *
 * @param {Object} [opts]
 * @param {string} [opts.broadcastAddress='255.255.255.255']  global broadcast by default;
 *        for a specific subnet, pass e.g. '192.168.1.255'
 * @param {number} [opts.timeoutMs=2000]  how long to wait for replies
 * @param {number} [opts.port=44818]      bound port (44818 by spec; usable for testing)
 * @returns {Promise<DiscoveredDevice[]>}
 */
async function discoverDevices(opts = {}) {
  const broadcastAddress = opts.broadcastAddress || '255.255.255.255';
  const timeoutMs = opts.timeoutMs || 2000;
  const port = opts.port || EIP_PORT;

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const devices = [];
    const seen = new Set();   // dedupe by ip:port

    socket.on('error', (err) => {
      try { socket.close(); } catch (_) {}
      reject(err);
    });

    socket.on('message', (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      if (seen.has(key)) return;
      seen.add(key);
      try {
        const device = _parseListIdentityReply(msg, rinfo);
        if (device) devices.push(device);
      } catch (_) {
        // Malformed reply — skip silently.
      }
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const msg = new EIPMessage({ command: Buffer.from([0x63, 0x00]) });
      const payload = msg.bytes();
      socket.send(payload, 0, payload.length, port, broadcastAddress, (err) => {
        if (err) {
          try { socket.close(); } catch (_) {}
          reject(err);
          return;
        }
        // Collect replies for the timeout window.
        setTimeout(() => {
          try { socket.close(); } catch (_) {}
          resolve(devices);
        }, timeoutMs).unref();
      });
    });
  });
}

/**
 * Parse a List Identity UDP reply into a DiscoveredDevice record.
 *
 * Wire format (after the 24-byte EIP header):
 *   command_specific_data:
 *     item_count        (uint16 LE) — typically 1
 *     for each item:
 *       type_id         (uint16 LE) — 0x000C for identity
 *       item_length     (uint16 LE)
 *       encap_version   (uint16 LE)
 *       sockaddr_in     (16 bytes — sin_family, sin_port, sin_addr, sin_zero)
 *       vendor_id       (uint16 LE)
 *       device_type     (uint16 LE)
 *       product_code    (uint16 LE)
 *       revision_major  (uint8)
 *       revision_minor  (uint8)
 *       status          (uint16 LE)
 *       serial_number   (uint32 LE)
 *       name_length     (uint8)
 *       product_name    (name_length bytes, ASCII)
 *       state           (uint8)
 */
function _parseListIdentityReply(buf, rinfo) {
  if (buf.length < 24) return null;
  const totalLen = 24 + buf.readUInt16LE(2);
  if (buf.length < totalLen) return null;
  const commandSpecific = buf.subarray(24);
  if (commandSpecific.length < 4) return null;

  const itemCount = commandSpecific.readUInt16LE(0);
  if (itemCount < 1) return null;

  // Skip item_count (2 bytes), find first item
  let off = 2;
  const typeId = commandSpecific.readUInt16LE(off); off += 2;
  const itemLength = commandSpecific.readUInt16LE(off); off += 2;
  if (typeId !== 0x000C) return null;   // not an identity item
  const itemEnd = off + itemLength;
  if (commandSpecific.length < itemEnd) return null;

  // Within the item:
  // encap_version (2) + sockaddr_in (16) = 18 bytes before vendor_id
  if (itemLength < 18 + 18) return null;  // minimum: 18 header + 18 minimum body

  /* const encapVersion = commandSpecific.readUInt16LE(off); */ off += 2;
  /* const sockaddr = commandSpecific.subarray(off, off + 16); */ off += 16;

  const vendorId       = commandSpecific.readUInt16LE(off); off += 2;
  const deviceType     = commandSpecific.readUInt16LE(off); off += 2;
  const productCode    = commandSpecific.readUInt16LE(off); off += 2;
  const revisionMajor  = commandSpecific.readUInt8(off);    off += 1;
  const revisionMinor  = commandSpecific.readUInt8(off);    off += 1;
  const status         = commandSpecific.readUInt16LE(off); off += 2;
  const serialNumber   = commandSpecific.readUInt32LE(off); off += 4;
  const nameLength     = commandSpecific.readUInt8(off);    off += 1;
  const productName    = commandSpecific.subarray(off, off + nameLength).toString('ascii'); off += nameLength;
  const state          = off < itemEnd ? commandSpecific.readUInt8(off) : 0;

  return {
    ip: rinfo.address,
    port: rinfo.port,
    vendorId,
    deviceType,
    productCode,
    revisionMajor,
    revisionMinor,
    status,
    serialNumber,
    productName,
    state,
  };
}

module.exports = { discoverDevices };
