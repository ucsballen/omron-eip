/// <reference types="node" />
import { EventEmitter } from 'events';
import { CIPRequest, CIPReply } from '../cip';

// ============================ messages ============================

export class DataAndAddressItem {
  static readonly NULL_ADDRESS_ITEM: Buffer;
  static readonly CONNECTED_TRANSPORT_PACKET: Buffer;
  static readonly UNCONNECTED_MESSAGE: Buffer;
  static readonly LIST_SERVICES_RESPONSE: Buffer;
  static readonly SOCKADDR_INFO_ORIGINATOR_TO_TARGET: Buffer;
  static readonly SOCKADDR_INFO_TARGET_TO_ORIGINATOR: Buffer;
  static readonly SEQUENCED_ADDRESS_ITEM: Buffer;
  constructor(typeId: Buffer, data: Buffer);
  typeId: Buffer;
  data: Buffer;
  length: Buffer;
  bytes(): Buffer;
  static fromBytes(buf: Buffer): DataAndAddressItem;
}

export class CommonPacketFormat {
  constructor(packets?: DataAndAddressItem[]);
  packets: DataAndAddressItem[];
  itemCount: number;
  bytes(): Buffer;
  static fromBytes(buf: Buffer): CommonPacketFormat;
}

export interface CommandSpecificDataArgs {
  interfaceHandle?: Buffer;
  timeout?: Buffer;
  encapsulatedPacket?: Buffer;
}
export class CommandSpecificData {
  constructor(args?: CommandSpecificDataArgs);
  interfaceHandle: Buffer;
  timeout: Buffer;
  encapsulatedPacket: Buffer;
  bytes(): Buffer;
  static fromBytes(buf: Buffer): CommandSpecificData;
}

export interface EIPMessageArgs {
  command?: Buffer;
  commandData?: Buffer;
  sessionHandleId?: Buffer;
  status?: Buffer;
  senderContextData?: Buffer;
  commandOptions?: Buffer;
}
export class EIPMessage {
  constructor(args?: EIPMessageArgs);
  command: Buffer;
  commandData: Buffer;
  sessionHandleId: Buffer;
  status: Buffer;
  senderContextData: Buffer;
  commandOptions: Buffer;
  length: Buffer;
  bytes(): Buffer;
  static fromBytes(buf: Buffer): EIPMessage;
  contextInteger(): bigint;
  setContext(value: bigint | number): void;
  totalLength(): number;
}

// ============================ dispatcher ============================

export interface Logger {
  debug(message: string, meta?: object): void;
  info(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

export interface EIPDispatcherOptions {
  host?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  resourceUnavailableRetries?: number;
  resourceUnavailableBackoffMs?: number;
  maxConcurrentRequests?: number;
  logger?: Partial<Logger> | null;
}

export class EIPDispatcher extends EventEmitter {
  constructor(opts?: EIPDispatcherOptions);
  host: string | null;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  resourceUnavailableRetries: number;
  resourceUnavailableBackoffMs: number;
  logger: Logger;
  isConnected: boolean;
  hasSession: boolean;
  sessionHandleId: Buffer;
  variables: Map<string, any>;
  userVariables: Map<string, any>;
  systemVariables: Map<string, any>;
  dataTypeDictionary: Map<string, any>;
  connectedSession: ConnectedSession | null;
  /** Set when a Class 3 Forward_Open is rejected and the dispatcher falls back to UCMM. */
  lastConnectedSessionOpenError: Error | null;

  connectExplicit(host?: string, timeoutMs?: number): Promise<void>;
  closeExplicit(): Promise<void>;

  sendEipMessage(eipMessage: EIPMessage): Promise<EIPMessage>;
  sendRrData(commandSpecificDataBytes: Buffer): Promise<CommonPacketFormat>;
  /** Send a connected (SendUnitData / 0x70) message. Pass the T->O connection ID so the
   *  reply can be correlated by connection ID (Omron zeros the sender_context). */
  sendUnitData(commandSpecificDataBytes: Buffer, connId?: number): Promise<CommonPacketFormat>;
  registerSession(commandData?: Buffer): Promise<EIPMessage>;
  listServices(): Promise<Buffer>;
  listIdentity(): Promise<Buffer>;
  listInterfaces(): Promise<Buffer>;

  executeCipCommand(request: CIPRequest): Promise<CIPReply>;
  readTagService(path: Buffer, numberOfElements?: number): Promise<CIPReply>;
  writeTagService(path: Buffer, requestServiceData: {
    dataType: Buffer;
    additionalInfoLength?: number;
    additionalInfo?: Buffer;
    data: Buffer;
  }, numberOfElements?: number): Promise<CIPReply>;
  getAttributeAllService(path: Buffer): Promise<CIPReply>;
  getAttributeSingleService(path: Buffer): Promise<CIPReply>;
  setAttributeSingleService(path: Buffer, data: Buffer): Promise<CIPReply>;
  getInstanceList(startInstanceId?: number, numberOfInstances?: number, userDefined?: boolean): Promise<CIPReply>;

  setMaxConcurrentRequests(n: number): void;

  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export const EIP_PORT: 44818;

// ============================ connectedSession ============================

/** A partial override of the default Forward_Open parameters. */
export interface ForwardOpenVariant {
  rpiMicroseconds?: number;
  connectionSize?: number;
  timeoutMultiplier?: number;
  transportClass?: number;
  priority?: number;
  timeoutTicks?: number;
  useLargeForwardOpen?: boolean;
}

export interface ConnectedSessionOptions extends ForwardOpenVariant {
  /** Override the ordered list of Forward_Open variants tried during negotiation. */
  forwardOpenVariants?: ForwardOpenVariant[];
}

export class ConnectedSession {
  constructor(dispatcher: EIPDispatcher, opts?: ConnectedSessionOptions);
  isOpen: boolean;
  /** The accepted parameter set after open() succeeds, otherwise null. */
  params: Required<ForwardOpenVariant> | null;
  /** O->T connection ID assigned by the controller (used to address outgoing packets). */
  otConnectionId: number;
  /** T->O connection ID chosen by us (used to correlate incoming replies). */
  toConnectionId: number;
  /** The last Forward_Open rejection, or null. */
  lastOpenError: Error | null;
  /** Negotiate and open the connection. Resolves true on success, throws if all variants fail. */
  open(): Promise<boolean>;
  sendCip(cipRequest: CIPRequest): Promise<CIPReply>;
  close(): Promise<void>;
}

// ============================ discovery (UDP broadcast) ============================
// (Forward declaration; actual implementation lives in lib/eip/discovery.js)

export interface DiscoveredDevice {
  ip: string;
  port: number;
  vendorId: number;
  deviceType: number;
  productCode: number;
  revisionMajor: number;
  revisionMinor: number;
  status: number;
  serialNumber: number;
  productName: string;
  state: number;
}

export interface DiscoveryOptions {
  broadcastAddress?: string;
  timeoutMs?: number;
  port?: number;
}

export function discoverDevices(opts?: DiscoveryOptions): Promise<DiscoveredDevice[]>;
