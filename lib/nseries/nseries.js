'use strict';
/**
 * NSeries: high-level Omron NX/NJ Sysmac controller client over EtherNet/IP.
 *
 * This is the Node.js equivalent of aphyt's AsyncNSeries class. Because JavaScript is
 * async-native, there's no separate sync wrapper — the same class serves both use cases,
 * and callers can `await` what they need. The three missing-await bugs from the Python
 * source (in _get_variable_object / _get_number_of_derived_data_types / _get_number_of_variables)
 * are fixed here.
 *
 * Lifecycle:
 *   const plc = new NSeries({ host: '192.168.1.100' });
 *   await plc.connect();
 *   await plc.updateVariableDictionary();   // optional: discover all tags up front
 *   const x = await plc.readVariable('MyTag');
 *   await plc.writeVariable('MyTag', 42);
 *   await plc.close();
 */

const fs = require('fs');
const fsp = require('fs/promises');

const {
  addressRequestPathSegment, variableRequestPathSegment,
  CIPCommonFormat, CIPException,
  CIPBoolean, CIPString, CIPArray, CIPStructure, CIPAbbreviatedStructure,
  createTypeInstance,
} = require('../cip');
const { EIPDispatcher } = require('../eip');
const {
  VariableTypeObjectReply, VariableObjectReply, InstanceIDAttributes,
} = require('./replies');
const { SimpleDataSegmentRequest } = require('./simpleDataSegment');
const { deepEqual } = require('../util');

/** UCMM maximum length is 502 bytes. Reads/writes that exceed this need fragmenting. */
const MAXIMUM_LENGTH = 502;

class NSeries {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.host]
   * @param {number} [opts.connectionTimeoutMs]
   * @param {number} [opts.requestTimeoutMs]
   * @param {number} [opts.maxConcurrentRequests=8]   in-flight cap on the dispatcher
   * @param {boolean} [opts.useConnectedMessaging=false] open a Class 3 connection if the
   *                  controller accepts one; otherwise transparently use UCMM
   * @param {Object} [opts.connectedMessagingOptions]  advanced Forward_Open tuning, passed
   *                  straight to ConnectedSession (rpiMicroseconds, connectionSize,
   *                  transportClass, useLargeForwardOpen, forwardOpenVariants, ...)
   * @param {Object}  [opts.logger]                   { debug, info, warn, error }
   */
  constructor(opts = {}) {
    this.host = opts.host || null;
    this.opts = opts;
    this.dispatcher = new EIPDispatcher(opts);
    this.derivedDataTypeDictionary = new Map();

    /** @type {InstanceIDAttributes[]} */ this.instances = [];
    /** @type {InstanceIDAttributes[]} */ this.userInstances = [];
    /** @type {InstanceIDAttributes[]} */ this.systemInstances = [];
  }

  // ------------------------------------------------------------- lifecycle

  async connect(host = this.host) {
    if (host) this.host = host;
    await this.dispatcher.connectExplicit(this.host);
    await this.dispatcher.registerSession();

    // Optional: try Class 3 connected explicit messaging. If it fails for any reason,
    // log and silently fall back to UCMM — the rest of the library still works.
    if (this.opts.useConnectedMessaging) {
      const { ConnectedSession } = require('../eip/connectedSession');
      const session = new ConnectedSession(this.dispatcher, this.opts.connectedMessagingOptions || {});
      try {
        await session.open();
        this.dispatcher.connectedSession = session;
      } catch (err) {
        this.dispatcher.logger.warn(
          'Class 3 ForwardOpen failed; falling back to UCMM',
          { error: err.message, status: err.statusCode, ext: err.extendedStatusCode }
        );
        this.dispatcher.connectedSession = null;
        // Preserve the rejection details so callers can surface them.
        this.dispatcher.lastConnectedSessionOpenError = err;
      }
    }
  }

  async close() {
    // Close the Class 3 connection first if we opened one.
    if (this.dispatcher.connectedSession) {
      try { await this.dispatcher.connectedSession.close(); } catch (_) {}
      this.dispatcher.connectedSession = null;
    }
    await this.dispatcher.closeExplicit();
  }

  /** True if a Class 3 connection is currently open (i.e. requests go via connected
   *  messaging). False means UCMM, whether by configuration or by fallback. */
  usingConnectedMessaging() {
    return !!(this.dispatcher.connectedSession && this.dispatcher.connectedSession.isOpen);
  }

  /** The error that caused Class 3 to fall back to UCMM, or null if none. */
  get connectedMessagingError() {
    return this.dispatcher.lastConnectedSessionOpenError || null;
  }

  /** Backwards-compat alias for users porting from aphyt. */
  async connectExplicit(host, connectionTimeoutMs) {
    if (connectionTimeoutMs !== undefined) this.dispatcher.connectionTimeoutMs = connectionTimeoutMs;
    await this.connect(host);
  }
  async closeExplicit() { await this.close(); }
  async registerSession() { /* handled inside connect(); kept for API parity */ }

  // ------------------------------------------------------------- variable discovery

  /**
   * Walk the Tag Name Server in chunks and return all instances of one subset
   * (user_defined=true → user vars, false → system vars).
   */
  async _getInstanceListSubset(userDefined) {
    const list = [];
    let current = 1;
    let done = false;
    while (!done) {
      const reply = await this.dispatcher.getInstanceList(current, 100, userDefined);
      const replyData = reply.replyData;
      const instanceCount = replyData.readUInt16LE(0);
      // Byte 2 of replyData is a "more" flag: 0 → no more, non-zero → keep paging.
      if (replyData.readUInt8(2) === 0 || instanceCount === 0) done = true;

      let cursor = replyData.subarray(4);
      let remaining = instanceCount;
      while (remaining > 0) {
        // Each record starts with: 2 bytes reserved + 2 bytes data_length, then data_length+2 bytes of payload.
        const dataLength = cursor.readUInt16LE(4);
        const record = cursor.subarray(4, 4 + dataLength + 2);
        list.push(new InstanceIDAttributes(record));
        cursor = cursor.subarray(4 + dataLength + 2);
        remaining--;
      }
      current += instanceCount;
    }
    return list;
  }

  /**
   * Populate the dispatcher's variable dictionary by walking both user and system tags.
   * Expensive — typically called once at startup, or skipped entirely in favor of
   * lazy discovery during read/writeVariable.
   */
  /**
   * Enumerate every published variable and resolve its type into the dictionary.
   *
   * @param {Object}  [opts]
   * @param {boolean} [opts.skipUnknown=true]  If a variable's type can't be resolved (e.g. an
   *   unrecognized CIP type code), skip it and continue rather than throwing. The skipped
   *   names are recorded in `this.skippedVariables` (array of {name, reason}). Set false to
   *   restore the old throw-on-first-unknown behavior.
   * @returns {Promise<{skipped: Array<{name: string, reason: string}>}>}
   */
  async updateVariableDictionary(opts = {}) {
    const skipUnknown = opts.skipUnknown !== false;   // default true
    this.userInstances   = await this._getInstanceListSubset(true);
    this.systemInstances = await this._getInstanceListSubset(false);
    this.instances       = [...this.userInstances, ...this.systemInstances];
    this.skippedVariables = [];

    const resolveInto = async (inst, targetMap) => {
      const name = inst.tagName();
      try {
        const typeInstance = await this._getInstanceFromVariableName(name);
        typeInstance.variableName = name;
        this.dispatcher.variables.set(name, typeInstance);
        targetMap.set(name, typeInstance);
      } catch (err) {
        if (!skipUnknown) throw err;
        this.skippedVariables.push({ name, reason: err.message });
        if (this.logger && this.logger.warn) {
          this.logger.warn(`updateVariableDictionary: skipping "${name}" (${err.message})`);
        }
      }
    };

    for (const inst of this.userInstances)   await resolveInto(inst, this.dispatcher.userVariables);
    for (const inst of this.systemInstances) await resolveInto(inst, this.dispatcher.systemVariables);

    return { skipped: this.skippedVariables };
  }

  variableList()       { return Array.from(this.dispatcher.variables.keys()); }
  userVariableList()   { return Array.from(this.dispatcher.userVariables.keys()); }
  systemVariableList() { return Array.from(this.dispatcher.systemVariables.keys()); }

  // ------------------------------------------------------------- dictionary persistence

  async saveCurrentDictionary(filename) {
    // Serializable form: { name → { typeCode, size, variableName, members?, dimensions? } }
    // We can't usefully pickle the typed instances (they hold Buffers and class refs),
    // so save a structural snapshot that's enough to re-discover types from typeCode.
    const out = {};
    for (const [name, inst] of this.dispatcher.variables) {
      out[name] = this._snapshotInstance(inst);
    }
    await fsp.writeFile(filename, JSON.stringify(out, null, 2));
  }

  _snapshotInstance(inst) {
    const snap = {
      typeCode: inst.constructor.dataTypeCode.toString('hex'),
      size: inst.size,
      variableName: inst.variableName,
    };
    if (inst instanceof CIPStructure) {
      snap.variableTypeName = inst.variableTypeName;
      snap.members = {};
      for (const [k, m] of inst.members) snap.members[k] = this._snapshotInstance(m);
      snap.crcCode = inst.crcCode.toString('hex');
    } else if (inst instanceof CIPArray) {
      snap.arrayDataType = inst.arrayDataType.toString('hex');
      snap.arrayDataTypeSize = inst.arrayDataTypeSize;
      snap.arrayDimensions = inst.arrayDimensions;
      snap.numberOfElements = inst.numberOfElements;
      snap.startArrayElements = inst.startArrayElements;
    }
    return snap;
  }

  async loadDictionaryFile(filename) {
    const raw = await fsp.readFile(filename, 'utf8');
    const dict = JSON.parse(raw);
    this.dispatcher.variables.clear();
    this.dispatcher.userVariables.clear();
    this.dispatcher.systemVariables.clear();
    for (const [name, snap] of Object.entries(dict)) {
      const inst = this._instanceFromSnapshot(snap);
      this.dispatcher.variables.set(name, inst);
      if (name.startsWith('_')) this.dispatcher.systemVariables.set(name, inst);
      else                      this.dispatcher.userVariables.set(name, inst);
    }
  }

  _instanceFromSnapshot(snap) {
    const inst = createTypeInstance(Buffer.from(snap.typeCode, 'hex'));
    if (!inst) throw new Error(`Unknown data type code 0x${snap.typeCode} in saved dictionary`);
    inst.size = snap.size;
    inst.variableName = snap.variableName;
    if (inst instanceof CIPStructure && snap.members) {
      inst.variableTypeName = snap.variableTypeName;
      inst.crcCode = Buffer.from(snap.crcCode, 'hex');
      for (const [k, ms] of Object.entries(snap.members)) inst.addMember(k, this._instanceFromSnapshot(ms));
    } else if (inst instanceof CIPArray) {
      const elem = createTypeInstance(Buffer.from(snap.arrayDataType, 'hex'));
      inst.fromInstance(elem, snap.arrayDataTypeSize, snap.arrayDimensions,
                        snap.numberOfElements, snap.startArrayElements);
    }
    return inst;
  }

  /** Convenience: try to load `filename` as a dictionary; if absent, discover and save. */
  async loadDictionaryFileIfPresent(filename) {
    try {
      await fsp.access(filename, fs.constants.R_OK);
      await this.loadDictionaryFile(filename);
    } catch (_) {
      await this.updateVariableDictionary();
      await this.saveCurrentDictionary(filename);
    }
  }

  // ------------------------------------------------------------- type-instance construction

  /**
   * Recursively build a CIPStructure from a Variable Type Object by walking the member chain.
   * Each member is reached via the nesting_variable_type_instance_id → first child, and
   * siblings are reached via each member's next_instance_id.
   */
  async _structureInstanceFromVariableTypeObject(vto) {
    const nestingId = vto.nestingVariableTypeInstanceId.readUInt32LE(0);
    const nestedVto = await this._getVariableTypeObject(nestingId);

    const struct = new CIPStructure();
    struct.instanceId = nestingId;

    if (vto.numberOfMembers === 0) {
      // Variable Type Object references a structure defined elsewhere — follow through.
      struct.variableTypeName = nestedVto.variableTypeName.toString('utf8');
      vto = nestedVto;
    } else {
      struct.variableTypeName = vto.variableTypeName.toString('utf8');
    }
    struct.size = vto.sizeInMemory;
    struct.crcCode = Buffer.alloc(2);
    struct.crcCode.writeUInt16LE(vto.crcCode, 0);

    let memberInstanceId = vto.nestingVariableTypeInstanceId.readUInt32LE(0);
    while (memberInstanceId !== 0) {
      const memberVto = await this._getVariableTypeObject(memberInstanceId);
      const memberInst = await this._getMemberInstance(memberInstanceId, memberVto);
      // Wire nested-struct callback so its child writes refresh the parent's serialized data.
      if (memberInst instanceof CIPStructure) {
        memberInst._parentCallback = () => struct.fromValue(struct);
      }
      const memberName = memberVto.variableTypeName.toString('utf8');
      struct.addMember(memberName, memberInst);
      memberInstanceId = memberVto.nextInstanceId.readUInt32LE(0);
    }
    return struct;
  }

  async _arrayInstanceFromVariableName(variableName) {
    const path = variableRequestPathSegment(variableName);
    const reply = await this.dispatcher.getAttributeAllService(path);
    // Reply data layout aligns with VariableObjectReply for this case.
    const attrs = new VariableObjectReply(reply);

    const instanceId = attrs.variableTypeInstanceId.readUInt32LE(0);
    const arr = new CIPArray();
    arr.instanceId = instanceId;

    const elemTypeCode = attrs.cipDataTypeOfArray;
    let elemInst;
    if (elemTypeCode.equals(CIPStructure.dataTypeCode) ||
        elemTypeCode.equals(CIPAbbreviatedStructure.dataTypeCode) ||
        elemTypeCode.equals(CIPArray.dataTypeCode)) {
      elemInst = await this._getMemberInstance(instanceId);
    } else if (elemTypeCode.equals(CIPString.dataTypeCode)) {
      elemInst = new CIPString();
      elemInst.size = attrs.size;
    } else {
      const ctor = this.dispatcher.dataTypeDictionary.get(elemTypeCode.toString('hex'))
                   || createTypeInstance(elemTypeCode)?.constructor;
      if (!ctor) throw new Error(`Unknown array element type 0x${elemTypeCode.toString('hex')}`);
      elemInst = new ctor();
    }

    arr.fromInstance(elemInst, attrs.size, attrs.arrayDimension,
                     attrs.numberOfElements, attrs.startArrayElements);
    arr.variableName = variableName;
    return arr;
  }

  async _arrayInstanceFromVariableTypeObject(vto) {
    const arr = new CIPArray();
    let instanceId = vto.nestingVariableTypeInstanceId;
    if (Buffer.isBuffer(instanceId)) instanceId = instanceId.readUInt32LE(0);
    arr.instanceId = instanceId;

    const elemTypeCode = vto.cipDataTypeOfArray;
    let elemInst;
    if (elemTypeCode.equals(CIPStructure.dataTypeCode) ||
        elemTypeCode.equals(CIPAbbreviatedStructure.dataTypeCode) ||
        elemTypeCode.equals(CIPArray.dataTypeCode)) {
      elemInst = await this._getMemberInstance(instanceId);
    } else if (elemTypeCode.equals(CIPString.dataTypeCode)) {
      elemInst = new CIPString();
      elemInst.size = vto.sizeInMemory;
    } else {
      elemInst = createTypeInstance(elemTypeCode);
      if (!elemInst) throw new Error(`Unknown array element type 0x${elemTypeCode.toString('hex')}`);
    }
    arr.fromInstance(elemInst, vto.size, vto.arrayDimension,
                     vto.numberOfElements, vto.startArrayElements);
    return arr;
  }

  /**
   * Take a member instance ID and produce the appropriate CIPDataType — recurses through
   * structures, abbreviated structures, strings, and arrays; falls back to the primitive
   * type registry for everything else.
   */
  async _getMemberInstance(memberInstanceId, vto = null) {
    if (!vto) vto = await this._getVariableTypeObject(memberInstanceId);
    const code = vto.cipDataType;

    if (code.equals(CIPStructure.dataTypeCode))           return this._structureInstanceFromVariableTypeObject(vto);
    if (code.equals(CIPAbbreviatedStructure.dataTypeCode))return this._structureInstanceFromVariableTypeObject(vto);
    if (code.equals(CIPString.dataTypeCode)) {
      const s = new CIPString();
      s.size = vto.size;
      return s;
    }
    if (code.equals(CIPArray.dataTypeCode)) return this._arrayInstanceFromVariableTypeObject(vto);

    const inst = createTypeInstance(code);
    if (!inst) throw new Error(`Unknown CIP data type 0x${code.toString('hex')}`);
    return inst;
  }

  /**
   * Resolve a variable name to a typed CIPDataType instance, caching the result in
   * the dispatcher's variable dictionary.
   */
  async _getInstanceFromVariableName(variableName) {
    const path = variableRequestPathSegment(variableName);
    let response = null;
    let dataTypeCode = Buffer.alloc(0);

    // Derived-data-type tokens (e.g. "MyStruct.Field" or "MyArr[3]") may need fallback handling.
    const tokens = variableName.split(/[\[\].]/).filter(Boolean);

    try {
      response = await this.dispatcher.getAttributeAllService(path);
      dataTypeCode = response.replyData.subarray(4, 5);
    } catch (err) {
      if (err instanceof CIPException && tokens.length > 1) {
        // OK — fall through to the derived-data-type walking branch below.
      } else {
        throw err;
      }
    }

    let inst;
    if (dataTypeCode.equals(CIPStructure.dataTypeCode) ||
        dataTypeCode.equals(CIPAbbreviatedStructure.dataTypeCode)) {
      const vtoId = response.replyData.readUInt32LE(8);
      const vto = await this._getVariableTypeObject(vtoId);
      inst = await this._structureInstanceFromVariableTypeObject(vto);
    } else if (dataTypeCode.equals(CIPString.dataTypeCode)) {
      const vtoId = response.replyData.readUInt32LE(8);
      const vto = await this._getVariableTypeObject(vtoId);
      inst = new CIPString();
      inst.size = response.replyData.readUInt16LE(0);
      void vto; // VTO walk would also work; not strictly needed for strings
    } else if (dataTypeCode.equals(CIPArray.dataTypeCode)) {
      inst = await this._arrayInstanceFromVariableName(variableName);
    } else if (dataTypeCode.length > 0) {
      inst = createTypeInstance(dataTypeCode);
      if (!inst) throw new Error(`Unknown data type 0x${dataTypeCode.toString('hex')} for ${variableName}`);
    } else {
      // Derived-data-type access: walk the parent and descend by token.
      let superInst = await this._getInstanceFromVariableName(tokens[0]);
      for (const tok of tokens.slice(1)) {
        if (/^\d+$/.test(tok)) {
          if (superInst._elemProto !== undefined && superInst._elemProto !== null) {
            superInst = superInst._elemProto;
          }
        } else if (superInst instanceof CIPStructure) {
          superInst = superInst.members.get(tok);
        }
      }
      inst = superInst;
    }

    inst.variableName = variableName;
    this.dispatcher.variables.set(variableName, inst);
    if (variableName.startsWith('_')) this.dispatcher.systemVariables.set(variableName, inst);
    else                              this.dispatcher.userVariables.set(variableName, inst);
    return inst;
  }

  // ------------------------------------------------------------- read

  /**
   * Read a variable and return its JS value.
   *
   * For primitives: a single read_tag_service call, unpacked via the type's value().
   * For strings/structures/arrays: a fragmented multi-message read via SimpleDataSegment.
   * For arrays of strings: each element is fetched individually (matching aphyt) since
   * Omron treats string arrays as a special case.
   */
  async readVariable(variableName) {
    const path = variableRequestPathSegment(variableName);
    let inst = this.dispatcher.variables.get(variableName);
    if (!inst) inst = await this._getInstanceFromVariableName(variableName);

    if (inst instanceof CIPString || inst instanceof CIPArray ||
        inst instanceof CIPStructure || inst instanceof CIPAbbreviatedStructure) {
      inst.variableName = variableName;

      if (inst instanceof CIPArray && inst._elemProto instanceof CIPString) {
        const strings = [];
        for (let i = 0; i < inst.numberOfElements[0]; i++) {
          strings.push(await this.readVariable(`${variableName}[${i}]`));
        }
        return strings;
      }
      await this._multiMessageVariableRead(inst);
      return inst.value();
    }

    const reply = await this.dispatcher.readTagService(path);
    inst.fromBytes(reply.replyData);
    inst.variableName = variableName;
    return inst.value();
  }

  // ------------------------------------------------------------- write

  /**
   * Write a JS value to a variable. The argument shape must match the variable's CIP type
   * (primitive → scalar, structure → plain object, array → nested array, string → string).
   */
  async writeVariable(variableName, data) {
    const path = variableRequestPathSegment(variableName);
    let inst = this.dispatcher.variables.get(variableName);
    if (!inst) inst = await this._getInstanceFromVariableName(variableName);

    inst.fromValue(data);

    if (inst instanceof CIPString || inst instanceof CIPArray ||
        inst instanceof CIPStructure || inst instanceof CIPAbbreviatedStructure) {
      inst.variableName = variableName;
      if (inst instanceof CIPArray && inst._elemProto instanceof CIPString) {
        for (let i = 0; i < inst.numberOfElements[0]; i++) {
          await this.writeVariable(`${variableName}[${i}]`, data[i]);
        }
        return;
      }
      await this._multiMessageVariableWrite(inst);
      return;
    }

    const requestData = new CIPCommonFormat({
      dataType: inst.constructor.dataTypeCode,
      data: inst.data,
    });
    await this.dispatcher.writeTagService(path, requestData);
  }

  /**
   * Write, then read back to confirm; retry up to `retryCount` times.
   *
   * Uses structural deepEqual (handles BigInt, Buffer, NaN) instead of JSON.stringify,
   * so verifiedWriteVariable works correctly for LINT/ULINT (BigInt) and byte/word
   * types (Buffer) which JSON.stringify mangles or throws on.
   */
  async verifiedWriteVariable(variableName, data, retryCount = 2) {
    let remaining = retryCount;
    let readBack;
    do {
      await this.writeVariable(variableName, data);
      readBack = await this.readVariable(variableName);
      if (deepEqual(readBack, data)) return;
      remaining--;
    } while (remaining >= 0);
    throw new Error(`verifiedWriteVariable: ${variableName} could not be confirmed within ${retryCount} retries`);
  }

  // ------------------------------------------------------------- bulk operations

  /**
   * Read many variables in one operation. Two strategies:
   *
   *   1. Multiple Service Packet (CIP 0x0A): pack all reads into ONE wire request.
   *      Faster, fewer round-trips. Not all NX/NJ firmware supports it; the library
   *      probes support at first use and remembers the result on the dispatcher.
   *
   *   2. Concurrent individual readVariable() calls bounded by the dispatcher's
   *      maxConcurrentRequests semaphore. Universal compatibility, more round-trips.
   *
   * Behavior is controlled by `opts.mode`:
   *   - 'auto'        (default): try MSP, fall back on SERVICE_NOT_SUPPORTED
   *   - 'multipleService': force MSP, throw if rejected
   *   - 'concurrent':  always use Promise.all over individual calls
   *
   * Returns an object: `{varName: value, ...}`. Tags that fail individually appear
   * as `{varName: { __error: Error }}` when `opts.partial === true` (default); when
   * partial is false, the first failure rejects the whole call.
   *
   * Note: bulk operations only work for **scalar** tags. Structures and arrays go
   * through their own single-tag read path because they may need multi-message
   * chunking. If you pass a struct/array name to readVariables, that one tag will
   * use the chunked path automatically.
   */
  async readVariables(names, opts = {}) {
    const mode = opts.mode || 'auto';
    const partial = opts.partial !== false;
    if (!Array.isArray(names) || names.length === 0) {
      throw new TypeError('readVariables: names must be a non-empty array');
    }

    // Tags that require multi-message read (struct / array / string) can't be packed
    // into MSP because their reply data is too large and includes the type prefix.
    // Pre-split into "fast" (scalar, MSP-able) and "slow" (multi-message, must run individually).
    const fastNames = [];
    const slowNames = [];
    for (const name of names) {
      const inst = this.dispatcher.variables.get(name);
      if (inst && (inst instanceof CIPString || inst instanceof CIPArray ||
                   inst instanceof CIPStructure || inst instanceof CIPAbbreviatedStructure)) {
        slowNames.push(name);
      } else {
        fastNames.push(name);
      }
    }

    const out = {};
    const concurrent = async (list) => {
      await Promise.all(list.map(async name => {
        try { out[name] = await this.readVariable(name); }
        catch (err) {
          if (!partial) throw err;
          out[name] = { __error: err };
        }
      }));
    };

    if (mode === 'concurrent' || slowNames.length === names.length) {
      await concurrent(names);
      return out;
    }

    const useMSP = mode === 'multipleService'
                || (mode === 'auto' && this._mspSupport !== false);

    if (useMSP && fastNames.length > 1) {
      try {
        const results = await this._readVariablesMSP(fastNames);
        Object.assign(out, results);
        if (this._mspSupport === undefined) this._mspSupport = true;
      } catch (err) {
        if (mode === 'multipleService') throw err;
        // Probe failure: mark MSP unsupported and fall through to concurrent.
        this.dispatcher.logger.info('MultipleServicePacket failed; using concurrent reads', { error: err.message });
        this._mspSupport = false;
        await concurrent(fastNames);
      }
    } else {
      await concurrent(fastNames);
    }
    // Always run slow tags concurrently (each goes through multi-message read).
    if (slowNames.length > 0) await concurrent(slowNames);
    return out;
  }

  /**
   * Internal: read a batch of scalar variables via Multiple Service Packet.
   * Returns an object {name: value}. Throws if MSP is rejected entirely;
   * individual per-tag errors throw out of here too (caller decides partial behavior).
   */
  async _readVariablesMSP(names) {
    const { buildMultipleServiceRequest, decodeMultipleServiceReply } = require('../cip');

    // Ensure every tag has a type instance.
    const instances = [];
    for (const name of names) {
      let inst = this.dispatcher.variables.get(name);
      if (!inst) inst = await this._getInstanceFromVariableName(name);
      instances.push(inst);
    }

    // Build one CIPRequest per tag (the same READ_TAG_SERVICE call individual reads make).
    const requests = names.map(name => {
      const path = variableRequestPathSegment(name);
      const data = Buffer.alloc(2); data.writeUInt16LE(1, 0); // numberOfElements
      return new (require('../cip')).CIPRequest(
        require('../cip').CIPService.READ_TAG_SERVICE, path, data);
    });

    const wrapped = buildMultipleServiceRequest(requests);
    const outer = await this.dispatcher.executeCipCommand(wrapped);
    const replies = decodeMultipleServiceReply(outer.replyData);

    if (replies.length !== names.length) {
      throw new Error(`MultipleServicePacket: got ${replies.length} replies for ${names.length} requests`);
    }

    const out = {};
    for (let i = 0; i < replies.length; i++) {
      const reply = replies[i];
      const inst = instances[i];
      const name = names[i];
      if (reply.generalStatus[0] !== 0) {
        const { CIPException } = require('../cip');
        throw new CIPException(reply.generalStatus, reply.extendedStatus);
      }
      inst.fromBytes(reply.replyData);
      inst.variableName = name;
      out[name] = inst.value();
    }
    return out;
  }

  /**
   * Write many variables in one operation. Same strategy options as readVariables
   * (`mode: 'auto' | 'multipleService' | 'concurrent'`).
   *
   * @param {Object} pairs   { variableName: value, ... }
   * @param {Object} [opts]
   * @returns {Promise<Object>}  `{varName: true}` on success, or `{varName: {__error: Error}}` if partial.
   */
  async writeVariables(pairs, opts = {}) {
    const mode = opts.mode || 'auto';
    const partial = opts.partial !== false;
    const names = Object.keys(pairs);
    if (names.length === 0) throw new TypeError('writeVariables: pairs must have at least one entry');

    const out = {};
    const concurrent = async (list) => {
      await Promise.all(list.map(async name => {
        try { await this.writeVariable(name, pairs[name]); out[name] = true; }
        catch (err) {
          if (!partial) throw err;
          out[name] = { __error: err };
        }
      }));
    };

    // For now, writes always go concurrent. MSP-based bulk write would require packing
    // write_tag_service requests, which complicates struct/array writes that need
    // multi-message handling anyway. The concurrent path benefits from the dispatcher's
    // semaphore so we never overwhelm the PLC.
    if (mode === 'multipleService') {
      throw new Error('writeVariables: mode "multipleService" is not yet implemented; use "concurrent" or "auto"');
    }
    await concurrent(names);
    return out;
  }

  // ------------------------------------------------------------- multi-message transfers

  /** Read a large CIPDataType in chunks via SimpleDataSegmentRequest. */
  async _multiMessageVariableRead(inst, offset = 0) {
    const maxReadSize = MAXIMUM_LENGTH - 8;
    let data = Buffer.alloc(0);
    while (offset < inst.size) {
      const remaining = inst.size - offset;
      const readSize = Math.min(maxReadSize, remaining);
      const reply = await this._simpleDataSegmentRead(inst, offset, readSize);
      const cf = CIPCommonFormat.fromBytes(reply.replyData);

      if (inst instanceof CIPString) {
        // First 2 bytes of the string segment are the count of characters read — strip them.
        data = Buffer.concat([data, cf.data.subarray(2)]);
      } else if (inst instanceof CIPStructure) {
        inst.crcCode = cf.additionalInfo;
        data = Buffer.concat([data, cf.data]);
      } else {
        data = Buffer.concat([data, cf.data]);
      }
      offset += maxReadSize;
    }
    inst.data = data;
    inst.value(); // re-materialize nested representations (recurses into structures/arrays)
    return inst;
  }

  /** Write a large CIPDataType in chunks via SimpleDataSegmentRequest. */
  async _multiMessageVariableWrite(inst, offset = 0) {
    const maxWriteSize = 400; // matches aphyt's conservative chunk size
    let response;
    while (offset < inst.size) {
      const remaining = inst.size - offset;
      const writeSize = Math.min(maxWriteSize, remaining);
      response = await this._simpleDataSegmentWrite(
        inst, offset, writeSize, inst.data.subarray(offset, offset + writeSize));
      offset += maxWriteSize;
    }
    return response;
  }

  async _simpleDataSegmentRead(inst, offset, readSize) {
    const basePath = variableRequestPathSegment(inst.variableName);
    const seg = new SimpleDataSegmentRequest(offset, readSize);
    const path = Buffer.concat([basePath, seg.bytes()]);
    return this.dispatcher.readTagService(path);
  }

  async _simpleDataSegmentWrite(inst, offset, writeSize, data) {
    const basePath = variableRequestPathSegment(inst.variableName);
    const seg = new SimpleDataSegmentRequest(offset, writeSize);
    const path = Buffer.concat([basePath, seg.bytes()]);

    let requestData;
    if (inst instanceof CIPString) {
      const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16LE(data.length, 0);
      requestData = new CIPCommonFormat({
        dataType: inst.constructor.dataTypeCode,
        data: Buffer.concat([lenBuf, data]),
      });
    } else if (inst instanceof CIPArray) {
      if (inst.arrayDataType.equals(CIPStructure.dataTypeCode)) {
        // Arrays-of-structs are written via abbreviated-structure with the type CRC as addl_info.
        const structVto = await this._getVariableTypeObject(inst.instanceId);
        const crcBuf = Buffer.alloc(2); crcBuf.writeUInt16LE(structVto.crcCode, 0);
        requestData = new CIPCommonFormat({
          dataType: CIPAbbreviatedStructure.dataTypeCode,
          additionalInfoLength: 2,
          additionalInfo: crcBuf,
          data,
        });
      } else {
        requestData = new CIPCommonFormat({
          dataType: inst.arrayDataType,
          data,
        });
      }
    } else if (inst instanceof CIPStructure) {
      requestData = new CIPCommonFormat({
        dataType: CIPAbbreviatedStructure.dataTypeCode,
        additionalInfoLength: 2,
        additionalInfo: inst.crcCode,
        data,
      });
    }
    return this.dispatcher.writeTagService(path, requestData);
  }

  // ------------------------------------------------------------- Variable / Variable Type object accessors

  /**
   * Get the Variable Object (class 0x6B) describing one published variable.
   * Fix vs aphyt: this was missing `await` in n_series.py.
   */
  async _getVariableObject(instanceId) {
    const idBuf = Buffer.alloc(2); idBuf.writeUInt16LE(instanceId, 0);
    const path = addressRequestPathSegment({ classId: Buffer.from([0x6b]), instanceId: idBuf });
    const reply = await this.dispatcher.getAttributeAllService(path);
    return new VariableObjectReply(reply);
  }

  /** Get the Variable Type Object (class 0x6C) describing one derived data type. */
  async _getVariableTypeObject(instanceId) {
    const idBuf = Buffer.alloc(2); idBuf.writeUInt16LE(instanceId, 0);
    const path = addressRequestPathSegment({ classId: Buffer.from([0x6c]), instanceId: idBuf });
    const reply = await this.dispatcher.getAttributeAllService(path);
    return new VariableTypeObjectReply(reply);
  }

  /** Number of derived data types defined on the controller. Fix vs aphyt: was missing `await`. */
  async _getNumberOfDerivedDataTypes() {
    const path = addressRequestPathSegment({ classId: Buffer.from([0x6c]), instanceId: Buffer.from([0x00, 0x00]) });
    const reply = await this.dispatcher.getAttributeAllService(path);
    return reply.replyData.readUInt16LE(2);
  }

  /** Number of variables on the controller. Fix vs aphyt: was missing `await`. */
  async _getNumberOfVariables() {
    const path = addressRequestPathSegment({ classId: Buffer.from([0x6a]), instanceId: Buffer.from([0x00, 0x00]) });
    const reply = await this.dispatcher.getAttributeAllService(path);
    return reply.replyData.readUInt16LE(2);
  }
}

module.exports = { NSeries, MAXIMUM_LENGTH };
