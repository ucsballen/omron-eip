'use strict';
/**
 * F4 vision sensor driver.
 *
 * Port of aphyt/omron/f4_series.py. **Not tested against real hardware in this port.**
 *
 * Layout follows aphyt's pattern:
 *   - Own internal EIPDispatcher (so you can use F4Series without bringing up NSeries)
 *   - Status register at class 0x6D / instance 1 / attribute 2
 *   - Control register at class 0x6D / instance 1 / attribute 1
 *   - Storage maps:
 *       class 0x68 - Boolean storage (attributes 1..200)
 *       class 0x69 - 16-bit Integer storage (attributes 1..200)
 *       class 0x6A - 32-bit Integer storage (attributes 1..200)
 *       class 0x6B - Floating Point storage (attributes 1..200)
 *       class 0x6C - String storage (attributes 1..200)
 *
 * Usage:
 *   const cam = new F4Series();
 *   await cam.connect('192.168.1.50');
 *   await cam.goOnline();
 *   await cam.triggerInspection();
 *   const result = cam.statusInspectionStatus();
 *   await cam.close();
 */

const { EIPDispatcher } = require('../eip');
const { addressRequestPathSegment, CIPBoolean, CIPInteger, CIPDoubleInteger, CIPReal } = require('../cip');

// ------------------------------- bit helpers -------------------------------

function setBit(data, bitPosition) {
  const length = data.length;
  let dataInt = BigInt('0x' + Buffer.from(data).reverse().toString('hex'));
  const mask = 1n << BigInt(bitPosition);
  dataInt |= mask;
  const hex = dataInt.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex, 'hex').reverse();
}

function clearBit(data, bitPosition) {
  const length = data.length;
  let dataInt = BigInt('0x' + Buffer.from(data).reverse().toString('hex'));
  const mask = ~(1n << BigInt(bitPosition));
  dataInt &= mask;
  // Truncate to original byte count
  const fullMask = (1n << BigInt(length * 8)) - 1n;
  dataInt &= fullMask;
  const hex = dataInt.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex, 'hex').reverse();
}

function testBit(data, bitPosition) {
  const byteIndex = Math.floor(bitPosition / 8);
  const bitInByte = bitPosition % 8;
  if (byteIndex >= data.length) return false;
  return (data[byteIndex] & (1 << bitInByte)) !== 0;
}

function clearBytes(data) {
  return Buffer.alloc(data.length);
}

// ------------------------------- F4Series -------------------------------

class F4Series {
  constructor() {
    this.dispatcher = new EIPDispatcher();
    this.status = Buffer.from([0x00, 0x00]);
    this.cameraControlRegister = Buffer.from([0x00, 0x00]);
  }

  async connect(host) {
    await this.dispatcher.connectExplicit(host);
    await this.dispatcher.registerSession();
  }

  async close() {
    await this.dispatcher.closeExplicit();
  }

  // Compatibility aliases
  connectExplicit(host) { return this.connect(host); }
  closeExplicit() { return this.close(); }
  registerSession() { /* handled in connect */ }

  // ------------------------------- control/status -------------------------------

  async getControlRegister() {
    const path = addressRequestPathSegment({
      classId: Buffer.from([0x6d, 0x00]),
      instanceId: Buffer.from([0x01]),
      attributeId: Buffer.from([0x01]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    return reply.replyData;
  }

  async getCameraStatus() {
    const path = addressRequestPathSegment({
      classId: Buffer.from([0x6d, 0x00]),
      instanceId: Buffer.from([0x01]),
      attributeId: Buffer.from([0x02]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    this.status = reply.replyData;
    return this.status;
  }

  statusOnline()                       { return testBit(this.status, 0); }
  statusExposureBusy()                 { return testBit(this.status, 1); }
  statusAcquisitionBusy()              { return testBit(this.status, 2); }
  statusTriggerReady()                 { return testBit(this.status, 3); }
  statusError()                        { return testBit(this.status, 4); }
  statusResetCountAcknowledgement()    { return testBit(this.status, 5); }
  statusExecuteCommandAcknowledgement(){ return testBit(this.status, 7); }
  statusTriggerAcknowledgement()       { return testBit(this.status, 8); }
  statusInspectionBusy()               { return testBit(this.status, 9); }
  statusInspectionStatus()             { return testBit(this.status, 10); }
  statusDataValid()                    { return testBit(this.status, 11); }

  // ------------------------------- storage maps -------------------------------

  async _readAttr(classByte, number) {
    if (number < 1 || number > 200) throw new RangeError(`F4: attribute number must be 1..200, got ${number}`);
    const attributeId = Buffer.alloc(2);
    attributeId.writeUInt16LE(number, 0);
    const path = addressRequestPathSegment({
      classId: Buffer.from([classByte, 0x00]),
      instanceId: Buffer.from([0x01]),
      attributeId,
    });
    return this.dispatcher.getAttributeSingleService(path);
  }

  async _writeAttr(classByte, number, data) {
    if (number < 1 || number > 200) throw new RangeError(`F4: attribute number must be 1..200, got ${number}`);
    const attributeId = Buffer.alloc(2);
    attributeId.writeUInt16LE(number, 0);
    const path = addressRequestPathSegment({
      classId: Buffer.from([classByte, 0x00]),
      instanceId: Buffer.from([0x01]),
      attributeId,
    });
    return this.dispatcher.setAttributeSingleService(path, data);
  }

  async getString(number) {
    const reply = await this._readAttr(0x6c, number);
    return reply.replyData.subarray(4).toString('utf8');
  }
  async setString(number, value) {
    const dataLength = Buffer.alloc(4);
    dataLength.writeUInt32LE(value.length, 0);
    const data = Buffer.concat([dataLength, Buffer.from(value, 'utf8')]);
    await this._writeAttr(0x6c, number, data);
  }

  async getBool(number) {
    const reply = await this._readAttr(0x68, number);
    return reply.replyData.equals(Buffer.from([0x01, 0x00]));
  }
  async setBool(number, value) {
    // The Python code reads then writes; the read seems to be a quirk of the camera.
    await this._readAttr(0x68, number);
    const cipBool = new CIPBoolean();
    cipBool.fromValue(Boolean(value));
    await this._writeAttr(0x68, number, cipBool.data);
  }

  async getInt(number) {
    const reply = await this._readAttr(0x69, number);
    const v = new CIPInteger();
    v.data = reply.replyData;
    return v.value();
  }
  async setInt(number, value) {
    const v = new CIPInteger();
    v.fromValue(value);
    await this._writeAttr(0x69, number, v.data);
  }

  async getLong(number) {
    const reply = await this._readAttr(0x6a, number);
    const v = new CIPDoubleInteger();
    v.data = reply.replyData;
    return v.value();
  }
  async setLong(number, value) {
    const v = new CIPDoubleInteger();
    v.fromValue(value);
    await this._writeAttr(0x6a, number, v.data);
  }

  async getFloat(number) {
    const reply = await this._readAttr(0x6b, number);
    const v = new CIPReal();
    v.data = reply.replyData;
    return v.value();
  }
  async setFloat(number, value) {
    const v = new CIPReal();
    v.fromValue(value);
    await this._writeAttr(0x6b, number, v.data);
  }

  // ------------------------------- control register operations -------------------------------

  /**
   * Push the current camera_control_register out, then clear it. Two-stage write matches
   * aphyt: the camera latches the rising edge of each control bit, so we set it, send it,
   * then send a cleared register so the same bit can be set again on a subsequent call.
   */
  async sendCommandRegister() {
    const path = addressRequestPathSegment({
      classId: Buffer.from([0x6d, 0x00]),
      instanceId: Buffer.from([0x01]),
      attributeId: Buffer.from([0x01]),
    });
    await this.dispatcher.setAttributeSingleService(path, this.cameraControlRegister);
    this.cameraControlRegister = clearBytes(this.cameraControlRegister);
    await this.dispatcher.setAttributeSingleService(path, this.cameraControlRegister);
  }

  async goOnline()         { this.cameraControlRegister = setBit(this.cameraControlRegister, 0);  await this.sendCommandRegister(); }
  async goOffline()        { this.cameraControlRegister = setBit(this.cameraControlRegister, 1);  await this.sendCommandRegister(); }
  async resetError()       { this.cameraControlRegister = setBit(this.cameraControlRegister, 4);  await this.sendCommandRegister(); }
  async resetCount()       { this.cameraControlRegister = setBit(this.cameraControlRegister, 5);  await this.sendCommandRegister(); }
  async executeCommand()   { this.cameraControlRegister = setBit(this.cameraControlRegister, 7);  await this.sendCommandRegister(); }
  async resetDataValid()   { this.cameraControlRegister = setBit(this.cameraControlRegister, 11); await this.sendCommandRegister(); }

  /** Trigger inspection 1. Waits for trigger_ready bit before issuing. */
  async triggerInspection() {
    await this.getCameraStatus();
    while (!this.statusTriggerReady()) {
      await this.getCameraStatus();
      // Yield to event loop so this doesn't burn CPU at 100%
      await new Promise(r => setImmediate(r));
    }
    this.cameraControlRegister = setBit(this.cameraControlRegister, 8);
    await this.sendCommandRegister();
  }
}

module.exports = { F4Series, setBit, clearBit, testBit, clearBytes };
