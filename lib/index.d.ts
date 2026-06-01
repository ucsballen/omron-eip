// Type definitions for omron-eip
// Hand-written to match the public API exposed by lib/index.js.

export * from './cip';
export * from './eip';
export * from './nseries';

import * as cip from './cip';
import * as eip from './eip';
export { cip, eip };
