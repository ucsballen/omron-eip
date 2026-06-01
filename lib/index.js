'use strict';
/**
 * omron-eip — Node.js EtherNet/IP client for Omron NX/NJ Sysmac controllers.
 *
 * Most callers want:
 *   const { NSeriesController } = require('omron-eip');
 *
 * Direct access to the layers is also available for advanced use:
 *   const { cip, eip, NSeries, MonitoredVariable } = require('omron-eip');
 *
 * Non-NX/NJ Omron device drivers (F4 vision, K6PM-TH thermal, V4 barcode):
 *   const { F4Series, K6PMTH, V4Series, TCPInterfaceObject } = require('omron-eip');
 */

const cip = require('./cip');
const eip = require('./eip');
const nseries = require('./nseries');
const products = require('./products');
const util = require('./util');

module.exports = {
  // Sub-packages, for advanced use.
  cip,
  eip,

  // Flat re-exports of the public surface.
  ...cip,
  ...eip,
  ...nseries,
  ...products,
  ...util,
};
