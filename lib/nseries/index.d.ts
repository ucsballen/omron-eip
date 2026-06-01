/// <reference types="node" />
import { EventEmitter } from 'events';
import { CIPReply } from '../cip';
import { EIPDispatcher, Logger, ConnectedSessionOptions } from '../eip';

// ============================ replies ============================

export class VariableTypeObjectReply {
  constructor(cipReply: CIPReply);
  cipReply: CIPReply;
  replyData: Buffer;
  readonly sizeInMemory: number;
  readonly size: number;
  readonly cipDataType: Buffer;
  readonly cipDataTypeOfArray: Buffer;
  readonly arrayDimension: number;
  readonly numberOfElements: number[];
  readonly numberOfMembers: number;
  readonly crcCode: number;
  readonly variableTypeNameLength: number;
  readonly padding: number;
  readonly variableTypeName: Buffer;
  readonly nextInstanceId: Buffer;
  readonly nestingVariableTypeInstanceId: Buffer;
  readonly startArrayElements: number[];
}

export class VariableObjectReply {
  constructor(cipReply: CIPReply);
  cipReply: CIPReply;
  replyData: Buffer;
  readonly size: number;
  readonly cipDataType: Buffer;
  readonly cipDataTypeOfArray: Buffer;
  readonly arrayDimension: number;
  readonly numberOfElements: number[];
  readonly bitNumber: number;
  readonly variableTypeInstanceId: Buffer;
  readonly startArrayElements: number[];
}

export class VariableNameAttributeAllReply {
  constructor(cipReply: CIPReply);
  readonly cipDataType: Buffer;
  readonly instanceId: Buffer;
  readonly variableTypeId: Buffer;
}

export class InstanceIDAttributes {
  constructor(data: Buffer);
  data: Buffer;
  readonly dataLength: number;
  readonly classId: Buffer;
  readonly instanceId: Buffer;
  tagNameLength(): number;
  tagName(): string;
}

// ============================ simple data segment ============================

export class SimpleDataSegmentRequest {
  constructor(offset: number, size: number);
  offset: number;
  size: number;
  bytes(): Buffer;
}

// ============================ NSeries ============================

export interface NSeriesOptions {
  host?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  /** Open a Class 3 connection if the controller accepts one; otherwise use UCMM. */
  useConnectedMessaging?: boolean;
  /** Advanced Forward_Open tuning, passed through to ConnectedSession. */
  connectedMessagingOptions?: ConnectedSessionOptions;
  logger?: Partial<Logger> | null;
}

export interface ReadVariablesOptions {
  /** 'auto' (default) tries MSP and falls back; 'multipleService' forces MSP; 'concurrent' always uses Promise.all. */
  mode?: 'auto' | 'multipleService' | 'concurrent';
  /** If true (default), tag-level errors appear as `{__error: Error}` in the result; if false, the first error rejects. */
  partial?: boolean;
}

export interface BulkResult {
  [variableName: string]: any | { __error: Error };
}

export class NSeries {
  constructor(opts?: NSeriesOptions);
  host: string | null;
  opts: NSeriesOptions;
  dispatcher: EIPDispatcher;
  derivedDataTypeDictionary: Map<string, any>;
  instances: InstanceIDAttributes[];
  userInstances: InstanceIDAttributes[];
  systemInstances: InstanceIDAttributes[];

  connect(host?: string): Promise<void>;
  close(): Promise<void>;
  connectExplicit(host?: string, connectionTimeoutMs?: number): Promise<void>;
  closeExplicit(): Promise<void>;
  registerSession(): Promise<void>;

  /** True if a Class 3 connection is currently open (requests go via connected messaging). */
  usingConnectedMessaging(): boolean;
  /** The error that caused Class 3 to fall back to UCMM, or null if none. */
  readonly connectedMessagingError: Error | null;

  readVariable(variableName: string): Promise<any>;
  writeVariable(variableName: string, data: any): Promise<void>;
  verifiedWriteVariable(variableName: string, data: any, retryCount?: number): Promise<void>;

  readVariables(names: string[], opts?: ReadVariablesOptions): Promise<BulkResult>;
  writeVariables(pairs: Record<string, any>, opts?: ReadVariablesOptions): Promise<BulkResult>;

  updateVariableDictionary(opts?: { skipUnknown?: boolean }): Promise<{ skipped: Array<{ name: string; reason: string }> }>;
  skippedVariables?: Array<{ name: string; reason: string }>;
  variableList(): string[];
  userVariableList(): string[];
  systemVariableList(): string[];

  saveCurrentDictionary(filename: string): Promise<void>;
  loadDictionaryFile(filename: string): Promise<void>;
  loadDictionaryFileIfPresent(filename: string): Promise<void>;
}

export const MAXIMUM_LENGTH: 502;

// ============================ MonitoredVariable ============================

export interface MonitoredVariableOptions {
  refreshTimeMs?: number;
  autoStart?: boolean;
}

export interface MonitorTarget {
  id?: string;
  readVariable(name: string): Promise<any>;
  verifiedWriteVariable(name: string, value: any, retry?: number): Promise<void>;
}

export class MonitoredVariable extends EventEmitter {
  constructor(dispatcher: MonitorTarget, variableName: string, opts?: MonitoredVariableOptions);
  readonly value: any;
  refreshTimeMs: number;
  setValue(v: any): Promise<void>;
  start(): void;
  cancel(): void;
  asyncIterator(): AsyncIterableIterator<any>;
  [Symbol.asyncIterator](): AsyncIterableIterator<any>;

  on(event: 'change', listener: (newValue: any, prevValue: any) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

// ============================ NSeriesController ============================

export interface NSeriesControllerOptions {
  host?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffJitter?: boolean;
  maxReconnectAttempts?: number;
  keepAlive?: boolean;
  keepAliveIntervalMs?: number;
  autoConnect?: boolean;
  maxConcurrentRequests?: number;
  useConnectedMessaging?: boolean;
  connectedMessagingOptions?: ConnectedSessionOptions;
  logger?: Partial<Logger> | null;
}

export class NSeriesController extends EventEmitter {
  constructor(opts?: NSeriesControllerOptions);
  id: string;
  host: string | null;
  opts: NSeriesControllerOptions;
  plc: NSeries | null;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;

  connect(host?: string): Promise<void>;
  close(): Promise<void>;

  readVariable(name: string): Promise<any>;
  writeVariable(name: string, data: any): Promise<void>;
  verifiedWriteVariable(name: string, data: any, retry?: number): Promise<void>;
  readVariables(names: string[], opts?: ReadVariablesOptions): Promise<BulkResult>;
  writeVariables(pairs: Record<string, any>, opts?: ReadVariablesOptions): Promise<BulkResult>;

  updateVariableDictionary(opts?: { skipUnknown?: boolean }): Promise<{ skipped: Array<{ name: string; reason: string }> }>;
  skippedVariables?: Array<{ name: string; reason: string }>;
  variableList(): string[];
  userVariableList(): string[];
  systemVariableList(): string[];

  saveCurrentDictionary(file: string): Promise<void>;
  loadDictionaryFile(file: string): Promise<void>;
  loadDictionaryFileIfPresent(file: string): Promise<void>;

  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: () => void): this;
  on(event: 'reconnect', listener: (attemptNumber: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'dispatcherError', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

// ============================ Product wrappers ============================

export class TCPInterfaceObject {
  constructor(dispatcher: EIPDispatcher);
  getInterfaceConfiguration(): Promise<{
    ipAddress: string;
    subnetMask: string;
    defaultGateway: string;
    primaryNameserver: string;
    secondaryNameserver: string;
    domainName: Buffer;
  }>;
  getHostName(): Promise<Buffer>;
  getEncapsulationInactivityTimeout(): Promise<number>;
  setEncapsulationInactivityTimeout(seconds: number): Promise<void>;
}

export class F4Series {
  constructor();
  connect(host: string): Promise<void>;
  close(): Promise<void>;
  getControlRegister(): Promise<Buffer>;
  getCameraStatus(): Promise<Buffer>;
  statusOnline(): boolean;
  statusExposureBusy(): boolean;
  statusAcquisitionBusy(): boolean;
  statusTriggerReady(): boolean;
  statusError(): boolean;
  statusResetCountAcknowledgement(): boolean;
  statusExecuteCommandAcknowledgement(): boolean;
  statusTriggerAcknowledgement(): boolean;
  statusInspectionBusy(): boolean;
  statusInspectionStatus(): boolean;
  statusDataValid(): boolean;
  getString(number: number): Promise<string>;
  setString(number: number, value: string): Promise<void>;
  getBool(number: number): Promise<boolean>;
  setBool(number: number, value: boolean): Promise<void>;
  getInt(number: number): Promise<number>;
  setInt(number: number, value: number): Promise<void>;
  getLong(number: number): Promise<number>;
  setLong(number: number, value: number): Promise<void>;
  getFloat(number: number): Promise<number>;
  setFloat(number: number, value: number): Promise<void>;
  sendCommandRegister(): Promise<void>;
  goOnline(): Promise<void>;
  goOffline(): Promise<void>;
  resetError(): Promise<void>;
  resetCount(): Promise<void>;
  executeCommand(): Promise<void>;
  triggerInspection(): Promise<void>;
  resetDataValid(): Promise<void>;
}

export interface SensorMonitorObject {
  sensorVersion: number | null;
  sensorStatus: number | null;
  alarmStatus: number | null;
  internalTemperatureValue: number | null;
  internalMaxTemperatureValue: number | null;
  internalPredictedArrivalTime: number | null;
  segmentTemperatureList: (number | null)[];
  segmentMaxTemperatureList: (number | null)[];
  segmentPredictedTemperature: (number | null)[];
}

export class K6PMTH {
  constructor();
  connect(host: string): Promise<void>;
  close(): Promise<void>;
  mainUnitStatus(): Promise<number>;
  runningTime(): Promise<number>;
  softwareVersion(): Promise<number>;
  numberOfConnectedSensors(): Promise<number>;
  sensorInPositionAdjustmentMode(): Promise<number>;
  sensorMonitorObject(sensorNumber: number): Promise<SensorMonitorObject>;
  sensorVersion(sensorNumber: number): Promise<number>;
  sensorStatus(sensorNumber: number): Promise<number>;
  sensorAlarmStatus(sensorNumber: number): Promise<number>;
  internalTemperature(sensorNumber: number): Promise<number>;
  internalMaximumTemperature(sensorNumber: number): Promise<number>;
  internalPredictedArrival(sensorNumber: number): Promise<number>;
  segmentTempCurrent(sensorNumber: number, segmentNumber: number): Promise<number>;
  segmentTempMax(sensorNumber: number, segmentNumber: number): Promise<number>;
  segmentTempPredicted(sensorNumber: number, segmentNumber: number): Promise<number>;
  pixelTemperatures(sensorNumber: number): Promise<number[][]>;
}

export class V4Series {
  constructor();
  connect(host: string): Promise<void>;
  close(): Promise<void>;
  executeCommand(command: string): Promise<Buffer>;
  readExecute(delimiter?: string): Promise<string>;
}
