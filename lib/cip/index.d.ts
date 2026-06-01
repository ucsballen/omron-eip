/// <reference types="node" />

// ============================ statusCodes ============================

export interface CIPStatusEntry {
  0: string;        // short name
  1: string;        // description
  readonly length: 2;
}

export const CIP_STATUS: { readonly [hexCode: string]: readonly [string, string] };

export class CIPException extends Error {
  constructor(status: Buffer, extendedStatus: Buffer);
  readonly name: 'CIPException';
  readonly status: Buffer;
  readonly extendedStatus: Buffer;
  readonly statusCode: string;
  readonly extendedStatusCode: string;
}

// ============================ crc ============================

export function cipCrc16(data: Buffer): Buffer;

// ============================ path ============================

export interface AddressRequestPathSegmentArgs {
  classId?: Buffer | null;
  instanceId?: Buffer | null;
  attributeId?: Buffer | null;
  elementId?: Buffer | null;
}

export function addressRequestPathSegment(args?: AddressRequestPathSegmentArgs): Buffer;
export function variableRequestPathSegment(variableName: string): Buffer;

// ============================ datatypes ============================

export abstract class CIPDataType {
  static dataTypeCode: Buffer;
  data: Buffer;
  size: number;
  additionalInfoLength: number;
  additionalInfo: Buffer;
  instanceId: any;
  variableName: string;
  readonly alignment: number;
  bytes(): Buffer;
  fromBytes(buf: Buffer): void;
  abstract value(): any;
  abstract fromValue(v: any): void;
}

export class CIPBoolean extends CIPDataType {
  value(): boolean;
  fromValue(v: boolean): void;
}
export class CIPShortInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPDoubleInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPLongInteger extends CIPDataType {
  value(): bigint;
  fromValue(v: bigint | number): void;
}
export class CIPUnsignedShortInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPUnsignedInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPUnsignedDoubleInteger extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPUnsignedLongInteger extends CIPDataType {
  value(): bigint;
  fromValue(v: bigint | number): void;
}
export class CIPReal extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPLongReal extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class CIPString extends CIPDataType {
  value(): string;
  fromValue(v: string): void;
}
export class CIPByte extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number): void;
}
export class CIPWord extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class CIPDoubleWord extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class CIPLongWord extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class CIPTime extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
// Omron-specific types (NX/NJ extensions, codes 0x04-0x0C)
export class OmronEnum extends CIPDataType {
  value(): number;
  fromValue(v: number): void;
}
export class OmronTime extends CIPDataType {
  value(): bigint;
  fromValue(v: bigint | number): void;
}
export class OmronTimeOfDay extends CIPDataType {
  value(): bigint;
  fromValue(v: bigint | number): void;
}
export class OmronDate extends CIPDataType {
  value(): Date;
  fromValue(v: Date | bigint | number): void;
}
export class OmronDateAndTime extends CIPDataType {
  value(): Date;
  fromValue(v: Date | bigint | number): void;
}
export class OmronUnion extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class OmronUintBCD extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class OmronUdintBCD extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class OmronUlintBCD extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer | number[]): void;
}
export class CIPAbbreviatedStructure extends CIPDataType {
  value(): Buffer;
  fromValue(v: Buffer): void;
}

export class CIPStructure extends CIPDataType {
  variableTypeName: string;
  members: Map<string, CIPDataType>;
  crcCode: Buffer;
  addMember(name: string, member: CIPDataType): void;
  value(): Record<string, any>;
  fromValue(v: Record<string, any> | CIPStructure): void;
}

export class CIPArray extends CIPDataType {
  arrayDataType: Buffer;
  arrayDataTypeSize: number;
  memberInstanceId: any;
  arrayDimensions: number;
  numberOfElements: number[];
  startArrayElements: number[];
  fromItems(
    arrayDataType: Buffer,
    arrayDataSize: number,
    ndim: number,
    counts: number[],
    starts: number[],
  ): void;
  fromInstance(
    elemInstance: CIPDataType,
    arrayDataSize: number,
    ndim: number,
    counts: number[],
    starts: number[],
  ): void;
  value(): any[];
  fromValue(v: any[]): void;
}

export const DATA_TYPE_REGISTRY: Map<string, typeof CIPDataType>;
export function registerType(cls: typeof CIPDataType): typeof CIPDataType;
export function getDataTypeClass(code: Buffer | string): typeof CIPDataType | null;
export function createTypeInstance(code: Buffer | string): CIPDataType | null;

// ============================ framing ============================

export interface CIPServiceConstants {
  readonly READ_TAG_SERVICE: Buffer;
  readonly READ_TAG_FRAGMENTED_SERVICE: Buffer;
  readonly WRITE_TAG_SERVICE: Buffer;
  readonly WRITE_TAG_FRAGMENTED_SERVICE: Buffer;
  readonly READ_MODIFY_WRITE_TAG_SERVICE: Buffer;
  readonly GET_ATTRIBUTE_ALL: Buffer;
  readonly GET_ATTRIBUTE_SINGLE: Buffer;
  readonly RESET: Buffer;
  readonly SET_ATTRIBUTE_SINGLE: Buffer;
  readonly GET_INSTANCE_LIST_EX2: Buffer;
  readonly MULTIPLE_SERVICE_PACKET: Buffer;
}
export const CIPService: CIPServiceConstants;

export class CIPRequest {
  constructor(service: Buffer, path: Buffer, data?: Buffer);
  service: Buffer;
  path: Buffer;
  data: Buffer;
  pathSize: number;
  readonly bytes: Buffer;
}

export class CIPReply {
  constructor(buf: Buffer);
  replyService: Buffer;
  reserved: Buffer;
  generalStatus: Buffer;
  extendedStatusSize: Buffer;
  extendedStatus: Buffer;
  replyData: Buffer;
  readonly bytes: Buffer;
}

export interface CIPCommonFormatArgs {
  dataType?: Buffer;
  additionalInfoLength?: number;
  additionalInfo?: Buffer;
  data?: Buffer;
}
export class CIPCommonFormat {
  constructor(args?: CIPCommonFormatArgs);
  dataType: Buffer;
  additionalInfoLength: number;
  additionalInfo: Buffer;
  data: Buffer;
  static fromBytes(buf: Buffer): CIPCommonFormat;
}

// ============================ multiService ============================

export const MESSAGE_ROUTER_PATH: Buffer;
export function encodeMultipleServiceBody(requests: CIPRequest[]): Buffer;
export function buildMultipleServiceRequest(requests: CIPRequest[]): CIPRequest;
export function decodeMultipleServiceReply(replyData: Buffer): CIPReply[];
