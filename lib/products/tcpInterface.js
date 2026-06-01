'use strict';
/**
 * TCP/IP Interface Object — CIP class 0xF5.
 *
 * Standard CIP object present on virtually every EtherNet/IP target. Lets you read
 * (and sometimes write) the device's IP configuration, hostname, and encapsulation
 * inactivity timeout.
 *
 * Port of aphyt/cip/cip_objects/tcp_interface.py.
 *
 * Usage:
 *   const tcp = new TCPInterfaceObject(plc.dispatcher);
 *   const config = await tcp.getInterfaceConfiguration();
 *   // → { ipAddress: '192.168.1.100', subnetMask: '255.255.255.0', ... }
 *
 * **Not tested against real hardware in this port.** The byte layout matches the CIP
 * spec and aphyt's implementation, but if a specific Omron firmware quirks the
 * interface_configuration attribute layout, that would only surface against a PLC.
 */

const { addressRequestPathSegment } = require('../cip');

const CLASS_ID = Buffer.from([0xf5]);
const INSTANCE_ID = Buffer.from([0x01]);

class TCPInterfaceObject {
  /** @param {Object} dispatcher  EIPDispatcher (or any object with getAttributeSingleService / setAttributeSingleService) */
  constructor(dispatcher) {
    this.dispatcher = dispatcher;
  }

  /**
   * Read the full interface_configuration attribute (class 0xF5, instance 1, attribute 5).
   * Returns IP-formatted strings for the four 32-bit addresses, raw bytes for domain name.
   */
  async getInterfaceConfiguration() {
    const path = addressRequestPathSegment({
      classId: CLASS_ID,
      instanceId: INSTANCE_ID,
      attributeId: Buffer.from([0x05]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    const d = reply.replyData;
    return {
      ipAddress:           _uintToIp(d.readUInt32LE(0)),
      subnetMask:          _uintToIp(d.readUInt32LE(4)),
      defaultGateway:      _uintToIp(d.readUInt32LE(8)),
      primaryNameserver:   _uintToIp(d.readUInt32LE(12)),
      secondaryNameserver: _uintToIp(d.readUInt32LE(16)),
      // Domain name follows as a length-prefixed string; we expose raw bytes so callers
      // don't have to worry about character encoding edge cases.
      domainName: d.subarray(20),
    };
  }

  /** Read host name (attribute 6). Returns raw bytes; encoding varies by device. */
  async getHostName() {
    const path = addressRequestPathSegment({
      classId: CLASS_ID,
      instanceId: INSTANCE_ID,
      attributeId: Buffer.from([0x06]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    return reply.replyData;
  }

  /**
   * Read encapsulation inactivity timeout (attribute 13). The PLC closes the EIP
   * session after this many seconds of no traffic. Default is usually 120s.
   */
  async getEncapsulationInactivityTimeout() {
    const path = addressRequestPathSegment({
      classId: CLASS_ID,
      instanceId: INSTANCE_ID,
      attributeId: Buffer.from([0x0d]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    return reply.replyData.readUInt16LE(0);
  }

  /**
   * Set encapsulation inactivity timeout in seconds. 0 disables the timeout entirely
   * (the PLC keeps the session open as long as the TCP connection is alive).
   */
  async setEncapsulationInactivityTimeout(seconds) {
    const path = addressRequestPathSegment({
      classId: CLASS_ID,
      instanceId: INSTANCE_ID,
      attributeId: Buffer.from([0x0d]),
    });
    const data = Buffer.alloc(2);
    data.writeUInt16LE(seconds & 0xffff, 0);
    await this.dispatcher.setAttributeSingleService(path, data);
  }

  /** Read interface configuration status (attribute 1). Bitfield indicating which fields are set. */
  async getInterfaceConfigurationStatus() {
    const path = addressRequestPathSegment({
      classId: CLASS_ID,
      instanceId: INSTANCE_ID,
      attributeId: Buffer.from([0x01]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    return reply.replyData.readUInt32LE(0);
  }
}

/** Format a uint32 (in CIP byte order — little-endian on the wire) as "a.b.c.d". */
function _uintToIp(uint32) {
  // CIP stores IPs as little-endian uint32; after readUInt32LE we have the host-order value.
  // The standard mapping is: high byte = first octet.
  return [
    (uint32 >>> 24) & 0xff,
    (uint32 >>> 16) & 0xff,
    (uint32 >>> 8)  & 0xff,
    (uint32)        & 0xff,
  ].join('.');
}

module.exports = { TCPInterfaceObject };
