'use strict';
/**
 * V4 barcode reader driver.
 *
 * Port of aphyt/omron/v4_series.py. **Not tested against real hardware in this port.**
 *
 * Uses Omron's vendor-specific service code 0x45 ("execute command") on class 0x68,
 * instance 1, attribute 1. The command is a length-prefixed UTF-8 string like "< >"
 * (read with space delimiter).
 */

const { EIPDispatcher } = require('../eip');
const { CIPRequest, addressRequestPathSegment } = require('../cip');

const SERVICE_EXECUTE_COMMAND = Buffer.from([0x45]);
const COMMAND_PATH = addressRequestPathSegment({
  classId: Buffer.from([0x68, 0x00]),
  instanceId: Buffer.from([0x01]),
  attributeId: Buffer.from([0x01]),
});

class V4Series {
  constructor() {
    this.dispatcher = new EIPDispatcher();
    this.lastReadLength = 0;
    this.lastReadString = '';
  }

  async connect(host) {
    await this.dispatcher.connectExplicit(host);
    await this.dispatcher.registerSession();
  }
  async close() { await this.dispatcher.closeExplicit(); }
  connectExplicit(host) { return this.connect(host); }
  closeExplicit() { return this.close(); }
  registerSession() { /* handled in connect */ }

  /**
   * Send a textual command to the V4. Command is length-prefixed as uint32 LE then UTF-8 bytes.
   * Returns the raw reply data (caller decides how to parse).
   */
  async executeCommand(command) {
    const cmdBytes = Buffer.from(command, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(cmdBytes.length, 0);
    const data = Buffer.concat([lenBuf, cmdBytes]);
    const request = new CIPRequest(SERVICE_EXECUTE_COMMAND, COMMAND_PATH, data);
    const reply = await this.dispatcher.executeCipCommand(request);
    return reply.replyData;
  }

  /**
   * Issue a read command and parse the response.
   *   delimiter: default ' ' (space) — produces "< >"
   * Returns the decoded string. Also updates `lastReadString` and `lastReadLength`.
   */
  async readExecute(delimiter = ' ') {
    const command = '<' + delimiter + '>';
    const reply = await this.executeCommand(command);
    const length = reply.readUInt32LE(0);
    this.lastReadLength = length;
    this.lastReadString = reply.subarray(4).toString('utf8');
    return this.lastReadString;
  }
}

module.exports = { V4Series };
