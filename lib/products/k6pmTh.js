'use strict';
/**
 * K6PM-TH thermal sensor driver.
 *
 * Port of aphyt/omron/k6pm_th.py. **Not tested against real hardware in this port.**
 *
 * CIP classes used:
 *   0x0374 — Main unit (status, software version, sensor count, etc.)
 *   0x0375 — Per-sensor monitor (instance = sensor number)
 *   0x0376 — Per-sensor pixel temperatures (instance = sensor number)
 *
 * Temperatures are stored as 16-bit unsigned ints in tenths of a degree; this driver
 * converts them to plain JS numbers (e.g. wire value 235 → 23.5 °C).
 */

const { EIPDispatcher } = require('../eip');
const { addressRequestPathSegment, CIPUnsignedInteger, CIPArray } = require('../cip');

const CLASS_MAIN_UNIT = Buffer.from([0x74, 0x03]);  // 0x0374
const CLASS_SENSOR    = Buffer.from([0x75, 0x03]);  // 0x0375
const CLASS_PIXELS    = Buffer.from([0x76, 0x03]);  // 0x0376

function _twoBytesToTemp(buf) {
  const raw = buf.readUInt16LE(0);
  return raw / 10;
}

class SensorMonitorObject {
  constructor() {
    this.sensorVersion = null;
    this.sensorStatus = null;
    this.alarmStatus = null;
    this.internalTemperatureValue = null;
    this.internalMaxTemperatureValue = null;
    this.internalPredictedArrivalTime = null;
    this.segmentTemperatureList = new Array(16).fill(null);
    this.segmentMaxTemperatureList = new Array(16).fill(null);
    this.segmentPredictedTemperature = new Array(16).fill(null);
  }

  fromBytes(buf) {
    this.sensorVersion = buf.readUInt16LE(0) / 10;
    this.sensorStatus  = buf.readUInt16LE(2) / 10;
    this.alarmStatus   = buf.readUInt16LE(4) / 10;
    this.internalTemperatureValue   = _twoBytesToTemp(buf.subarray(6, 8));
    this.internalMaxTemperatureValue = _twoBytesToTemp(buf.subarray(8, 10));
    this.internalPredictedArrivalTime = _twoBytesToTemp(buf.subarray(10, 12));

    const tempOff    = 12;
    const maxOff     = tempOff + 16;
    const predictOff = maxOff;  // same offset — matches the Python port's behavior
    for (let i = 0; i < 16; i++) {
      this.segmentTemperatureList[i]    = _twoBytesToTemp(buf.subarray(tempOff    + i*2, tempOff    + i*2 + 2));
      this.segmentMaxTemperatureList[i] = _twoBytesToTemp(buf.subarray(maxOff     + i*2, maxOff     + i*2 + 2));
      this.segmentPredictedTemperature[i] = _twoBytesToTemp(buf.subarray(predictOff + i*2, predictOff + i*2 + 2));
    }
  }
}

class K6PMTH {
  constructor() {
    this.dispatcher = new EIPDispatcher();
  }

  async connect(host) {
    await this.dispatcher.connectExplicit(host);
    await this.dispatcher.registerSession();
  }
  async close() { await this.dispatcher.closeExplicit(); }
  connectExplicit(host) { return this.connect(host); }
  closeExplicit() { return this.close(); }
  registerSession() { /* handled in connect */ }

  // ------------------------------- main unit -------------------------------

  async _readMainAttr(attrId) {
    const path = addressRequestPathSegment({
      classId: CLASS_MAIN_UNIT,
      instanceId: Buffer.from([0x01]),
      attributeId: Buffer.from([attrId]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    const v = new CIPUnsignedInteger();
    v.data = reply.replyData;
    return v.value();
  }

  mainUnitStatus()                 { return this._readMainAttr(0x64); }
  runningTime()                    { return this._readMainAttr(0x65); }
  softwareVersion()                { return this._readMainAttr(0x66); }
  numberOfConnectedSensors()       { return this._readMainAttr(0x67); }
  sensorInPositionAdjustmentMode() { return this._readMainAttr(0x68); }

  // ------------------------------- per-sensor -------------------------------

  async _readSensorAttr(sensorNumber, attrId, asTemperature = false) {
    const path = addressRequestPathSegment({
      classId: CLASS_SENSOR,
      instanceId: Buffer.from([sensorNumber & 0xff]),
      attributeId: Buffer.from([attrId]),
    });
    const reply = await this.dispatcher.getAttributeSingleService(path);
    const v = new CIPUnsignedInteger();
    v.data = reply.replyData;
    return asTemperature ? v.value() / 10 : v.value();
  }

  async sensorMonitorObject(sensorNumber) {
    const path = addressRequestPathSegment({
      classId: CLASS_SENSOR,
      instanceId: Buffer.from([sensorNumber & 0xff]),
    });
    const reply = await this.dispatcher.getAttributeAllService(path);
    const obj = new SensorMonitorObject();
    obj.fromBytes(reply.replyData);
    return obj;
  }

  sensorVersion(n)       { return this._readSensorAttr(n, 0x64); }
  sensorStatus(n)        { return this._readSensorAttr(n, 0x65); }
  sensorAlarmStatus(n)   { return this._readSensorAttr(n, 0x66); }
  internalTemperature(n)         { return this._readSensorAttr(n, 0x67, true); }
  internalMaximumTemperature(n)  { return this._readSensorAttr(n, 0x68, true); }
  internalPredictedArrival(n)    { return this._readSensorAttr(n, 0x69, true); }

  segmentTempCurrent(sensorNumber, segmentNumber)   { return this._readSensorAttr(sensorNumber, 0x6a + segmentNumber, true); }
  segmentTempMax(sensorNumber, segmentNumber)       { return this._readSensorAttr(sensorNumber, 0x7a + segmentNumber, true); }
  segmentTempPredicted(sensorNumber, segmentNumber) { return this._readSensorAttr(sensorNumber, 0x8a + segmentNumber, true); }

  // ------------------------------- pixel temperatures -------------------------------

  /**
   * Read all 16 attributes (0x64..0x73) of the per-sensor pixel temperatures class.
   * Each attribute is a 64-element UINT array. Returns a 16-row × 64-column matrix
   * of temperatures (in °C).
   */
  async pixelTemperatures(sensorNumber) {
    const result = [];
    for (let i = 0; i < 16; i++) {
      const path = addressRequestPathSegment({
        classId: CLASS_PIXELS,
        instanceId: Buffer.from([sensorNumber & 0xff]),
        attributeId: Buffer.from([0x64 + i]),
      });
      const reply = await this.dispatcher.getAttributeSingleService(path);
      const arr = new CIPArray();
      const elem = new CIPUnsignedInteger();
      arr.fromInstance(elem, elem.size, 1, [64], [0]);
      arr.data = reply.replyData;
      // Convert raw uint16 (tenths) to °C
      result.push(arr.value().map(raw => raw / 10));
    }
    return result;
  }
}

module.exports = { K6PMTH, SensorMonitorObject };
