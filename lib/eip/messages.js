'use strict';
/**
 * EtherNet/IP encapsulation framing.
 *
 * The nesting (from outer to inner):
 *   EIPMessage
 *     └── CommandSpecificData       (interface_handle + timeout + encapsulated_packet)
 *           └── CommonPacketFormat  (item_count + DataAndAddressItem list)
 *                 └── DataAndAddressItem  (type_id + length + data)
 *                       └── CIP message
 *                             └── route path
 *
 * Ported from aphyt eip.py.
 */

class DataAndAddressItem {
  static NULL_ADDRESS_ITEM                  = Buffer.from([0x00, 0x00]);
  static CONNECTED_TRANSPORT_PACKET         = Buffer.from([0xb1, 0x00]);
  static UNCONNECTED_MESSAGE                = Buffer.from([0xb2, 0x00]);
  static LIST_SERVICES_RESPONSE             = Buffer.from([0x00, 0x01]);
  static SOCKADDR_INFO_ORIGINATOR_TO_TARGET = Buffer.from([0x00, 0x80]);
  static SOCKADDR_INFO_TARGET_TO_ORIGINATOR = Buffer.from([0x01, 0x80]);
  static SEQUENCED_ADDRESS_ITEM             = Buffer.from([0x02, 0x80]);

  /**
   * @param {Buffer} typeId 2-byte item type
   * @param {Buffer} data
   */
  constructor(typeId, data) {
    this.typeId = typeId;
    this.data = data;
    this.length = Buffer.alloc(2);
    this.length.writeUInt16LE(data.length, 0);
  }

  static fromBytes(buf) {
    const typeId = buf.subarray(0, 2);
    const len = buf.readUInt16LE(2);
    return new DataAndAddressItem(typeId, buf.subarray(4, 4 + len));
  }

  bytes() {
    return Buffer.concat([this.typeId, this.length, this.data]);
  }
}

class CommonPacketFormat {
  /** @param {DataAndAddressItem[]} packets */
  constructor(packets = []) {
    // Match aphyt: always exactly two slots — first is null-address, second is the payload.
    this.packets = [
      new DataAndAddressItem(DataAndAddressItem.NULL_ADDRESS_ITEM, Buffer.alloc(0)),
      new DataAndAddressItem(DataAndAddressItem.NULL_ADDRESS_ITEM, Buffer.alloc(0)),
    ];
    if (packets.length === 1) this.packets[1] = packets[0];
    else if (packets.length >= 2) this.packets = packets;
    this.itemCount = this.packets.length;
  }

  static fromBytes(buf) {
    const itemCount = buf.readUInt16LE(0);
    const cpf = new CommonPacketFormat();
    cpf.itemCount = itemCount;
    cpf.packets = [];
    let offset = 2;
    for (let i = 0; i < itemCount; i++) {
      const len = buf.readUInt16LE(offset + 2);
      const item = DataAndAddressItem.fromBytes(buf.subarray(offset, offset + 4 + len));
      cpf.packets.push(item);
      offset += 4 + len;
    }
    return cpf;
  }

  bytes() {
    const count = Buffer.alloc(2);
    count.writeUInt16LE(this.itemCount, 0);
    return Buffer.concat([count, ...this.packets.map(p => p.bytes())]);
  }
}

class CommandSpecificData {
  constructor({
    interfaceHandle = Buffer.from([0x00, 0x00, 0x00, 0x00]),
    timeout = Buffer.from([0x08, 0x00]),
    encapsulatedPacket = Buffer.alloc(0),
  } = {}) {
    this.interfaceHandle = interfaceHandle;
    this.timeout = timeout;
    this.encapsulatedPacket = encapsulatedPacket;
  }

  static fromBytes(buf) {
    return new CommandSpecificData({
      interfaceHandle: buf.subarray(0, 4),
      timeout: buf.subarray(4, 6),
      encapsulatedPacket: buf.subarray(6),
    });
  }

  bytes() {
    return Buffer.concat([this.interfaceHandle, this.timeout, this.encapsulatedPacket]);
  }
}

/**
 * EtherNet/IP message — 24-byte header followed by command_data.
 *   command (2) + length (2) + session_handle (4) + status (4) +
 *   sender_context (8) + command_options (4) + command_data
 *
 * Commands used in this library:
 *   0x0004 list_services         0x0063 list_identity         0x0064 list_interfaces
 *   0x0065 register_session      0x0066 unregister_session    0x006f send_rr_data
 */
class EIPMessage {
  constructor({
    command = Buffer.from([0x00, 0x00]),
    commandData = Buffer.alloc(0),
    sessionHandleId = Buffer.from([0x00, 0x00, 0x00, 0x00]),
    status = Buffer.from([0x00, 0x00, 0x00, 0x00]),
    senderContextData = Buffer.alloc(8),
    commandOptions = Buffer.from([0x00, 0x00, 0x00, 0x00]),
  } = {}) {
    this.command = command;
    this.commandData = commandData;
    this.sessionHandleId = sessionHandleId;
    this.status = status;
    this.senderContextData = senderContextData;
    this.commandOptions = commandOptions;
    this.length = Buffer.alloc(2);
    this.length.writeUInt16LE(commandData.length, 0);
  }

  bytes() {
    return Buffer.concat([
      this.command, this.length, this.sessionHandleId, this.status,
      this.senderContextData, this.commandOptions, this.commandData,
    ]);
  }

  static fromBytes(buf) {
    const msg = new EIPMessage();
    msg.command           = buf.subarray(0, 2);
    msg.length            = buf.subarray(2, 4);
    msg.sessionHandleId   = buf.subarray(4, 8);
    msg.status            = buf.subarray(8, 12);
    msg.senderContextData = buf.subarray(12, 20);
    msg.commandOptions    = buf.subarray(20, 24);
    msg.commandData       = buf.subarray(24);
    return msg;
  }

  /** Read sender_context as a 64-bit unsigned integer (used for request/response correlation). */
  contextInteger() { return this.senderContextData.readBigUInt64LE(0); }

  /** Write sender_context from a 64-bit unsigned integer. */
  setContext(value) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value), 0);
    this.senderContextData = buf;
  }

  /** Total wire length: 24-byte header + payload. */
  totalLength() { return 24 + this.length.readUInt16LE(0); }
}

module.exports = {
  DataAndAddressItem,
  CommonPacketFormat,
  CommandSpecificData,
  EIPMessage,
};
