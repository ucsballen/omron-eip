# Examples and API reference

Every method of `omron-eip`, with copy-pasteable examples. Assumes you've already worked through **[INSTALL.md](./INSTALL.md)** and confirmed your PLC is reachable.

## Table of contents

1. [Three classes - which one to use?](#1-three-classes-which-one-to-use)
2. [Reading variables - every CIP type](#2-reading-variables-every-cip-type)
3. [Writing variables - every CIP type](#3-writing-variables-every-cip-type)
4. [Working with structures](#4-working-with-structures)
5. [Working with arrays](#5-working-with-arrays)
6. [Verified writes](#6-verified-writes)
7. [Bulk read and write](#7-bulk-read-and-write)
8. [Variable discovery and the dictionary](#8-variable-discovery-and-the-dictionary)
9. [Saving and loading the dictionary](#9-saving-and-loading-the-dictionary)
10. [Monitored variables (polling)](#10-monitored-variables-polling)
11. [NSeriesController - auto-reconnect and keep-alive](#11-nseriescontroller-auto-reconnect-and-keep-alive)
12. [Class 3 connected explicit messaging](#12-class-3-connected-explicit-messaging)
13. [UDP broadcast discovery](#13-udp-broadcast-discovery)
14. [TypeScript users](#14-typescript-users)
15. [Non-NX/NJ Omron devices](#15-non-nxnj-omron-devices)
16. [Error handling](#16-error-handling)
17. [Low-level CIP access](#17-low-level-cip-access)
18. [Complete API reference](#18-complete-api-reference)

---

## 1. Three classes - which one to use?

| Class | Use when | Reconnects? | Events? |
|---|---|---|---|
| `NSeries` | One-shot scripts, tests, quick debugging | No | No |
| `NSeriesController` | Long-running services, Node-RED, anything in production | Yes | Yes |
| `MonitoredVariable` | Reacting to value changes (e.g., update UI, log alerts) | Via the controller you pass it | Yes (`'change'`, `'error'`) |

Typical pattern: **one `NSeriesController` per PLC**, shared by many readers/writers and `MonitoredVariable` instances.

---

## 2. Reading variables - every CIP type

`plc.readVariable(name)` returns native JS values that match the controller's data type. The library figures out the type the first time you read or write a tag, so you don't have to declare it.

```js
const { NSeries } = require('omron-eip');
const plc = new NSeries({ host: '192.168.1.100' });
await plc.connect();

// --- numeric scalars ---
const aBool   = await plc.readVariable('TestBool');    // -> true / false
const aSint   = await plc.readVariable('TestSint');    // -> -128..127
const anInt   = await plc.readVariable('TestInt');     // -> -32768..32767
const aDint   = await plc.readVariable('TestDint');    // -> -2^31..2^31-1
const aLint   = await plc.readVariable('TestLint');    // -> BigInt (e.g. 123456789n)
const aUsint  = await plc.readVariable('TestUsint');   // -> 0..255
const aUint   = await plc.readVariable('TestUint');    // -> 0..65535
const aUdint  = await plc.readVariable('TestUdint');   // -> 0..2^32-1
const aUlint  = await plc.readVariable('TestUlint');   // -> BigInt
const aReal   = await plc.readVariable('TestReal');    // -> number (float32)
const aLreal  = await plc.readVariable('TestLreal');   // -> number (float64)

// --- string ---
const aString = await plc.readVariable('TestString');  // -> "hello world"

// --- byte/word/dword/lword (raw bit-bags) ---
const aByte  = await plc.readVariable('TestByte');     // -> Buffer (1 byte)
const aWord  = await plc.readVariable('TestWord');     // -> Buffer (2 bytes)
const aDword = await plc.readVariable('TestDword');    // -> Buffer (4 bytes)
const aLword = await plc.readVariable('TestLword');    // -> Buffer (8 bytes)

// --- Omron-specific types (NX/NJ extensions) ---
const anEnum = await plc.readVariable('TestEnum');     // -> number (the enum's integer value)
const aDate  = await plc.readVariable('TestDate');     // -> JS Date (DATE)
const aDT    = await plc.readVariable('TestDateTime'); // -> JS Date (DATE_AND_TIME)
const aTime  = await plc.readVariable('TestTime');     // -> BigInt nanoseconds (TIME)
const aTod   = await plc.readVariable('TestTimeOfDay');// -> BigInt nanoseconds (TIME_OF_DAY)

await plc.close();
```

**Why BigInt for LINT/ULINT?** JavaScript `Number` only safely represents integers up to 2^53-1. The 64-bit Omron types can exceed that, so `BigInt` is the only way to avoid precision loss. Convert with `Number(bigintValue)` if you know the value fits.

**Omron-specific types.** NX/NJ controllers publish a few types beyond the standard CIP set (codes `0x04`–`0x0C`): `ENUM` (read as the integer enum value), `DATE`/`DATE_AND_TIME` (read as a JS `Date`), `TIME`/`TIME_OF_DAY` (read as BigInt nanoseconds), `UNION` (raw `Buffer`), and BCD types (raw `Buffer`). You don't have to do anything special — `readVariable` returns the decoded value automatically. These were added in 0.2.4; before that, enumerating a dictionary containing one of them would error.

---

## 3. Writing variables - every CIP type

`plc.writeVariable(name, value)` accepts native JS values. The library handles the byte packing.

```js
await plc.writeVariable('TestBool',  true);
await plc.writeVariable('TestSint',  -42);
await plc.writeVariable('TestInt',   1234);
await plc.writeVariable('TestDint',  1000000);
await plc.writeVariable('TestLint',  123456789n);          // BigInt OR Number both work
await plc.writeVariable('TestUsint', 200);
await plc.writeVariable('TestUint',  60000);
await plc.writeVariable('TestUdint', 4000000000);
await plc.writeVariable('TestUlint', 18000000000000000000n);
await plc.writeVariable('TestReal',  3.14);
await plc.writeVariable('TestLreal', 2.718281828);
await plc.writeVariable('TestString', 'hello');

// Bit-bag types take a Buffer
await plc.writeVariable('TestByte', Buffer.from([0xff]));
await plc.writeVariable('TestWord', Buffer.from([0xaa, 0xbb]));

// Omron-specific types
await plc.writeVariable('TestEnum', 3);                    // ENUM: the integer enum value
await plc.writeVariable('TestDate', new Date());           // DATE: a JS Date
await plc.writeVariable('TestDateTime', new Date());       // DATE_AND_TIME: a JS Date
await plc.writeVariable('TestTime', 5000000000n);          // TIME: BigInt nanoseconds (5 s)
await plc.writeVariable('TestTimeOfDay', 3600000000000n);  // TIME_OF_DAY: BigInt nanoseconds
```

If you write a `Number` to a LINT, the library will accept it and convert via `BigInt(value)`. Pass `BigInt` directly if you want to be sure the value isn't silently coerced.

> **Note on date/time writes:** reads and writes for the Omron date/time types are
> hardware-verified to **millisecond** precision. DATE / DATE_AND_TIME use nanoseconds since the
> 1970 epoch (a JS `Date` is the easiest input from JavaScript; a `BigInt`/`Number` of
> nanoseconds also works). TIME / TIME_OF_DAY are a nanosecond duration. Because the underlying
> value is a 64-bit nanosecond integer, sub-millisecond digits can be lost if you pass a value
> as a plain `Number` rather than a `BigInt` — use `BigInt` (e.g. `5000000000n`) when you need
> full nanosecond precision.

---

## 4. Working with structures

Define a structure in Sysmac Studio:

```
Type:  RecipeData (Structure)
Members:
  Speed     UINT
  Position  DINT
  Active    BOOL
  Name      STRING[32]
```

Then a published variable of that type:

```
Name:             CurrentRecipe
Data type:        RecipeData
Network Publish:  Publish Only
```

Read it as a plain JS object:

```js
const recipe = await plc.readVariable('CurrentRecipe');
// -> { Speed: 1500, Position: 12000, Active: true, Name: "WidgetA" }

console.log(recipe.Speed);    // 1500
console.log(recipe.Name);     // "WidgetA"
```

Write the whole structure at once:

```js
await plc.writeVariable('CurrentRecipe', {
  Speed: 2000,
  Position: 0,
  Active: false,
  Name: 'WidgetB',
});
```

Or write just one member by addressing it directly:

```js
await plc.writeVariable('CurrentRecipe.Speed', 2500);
const speed = await plc.readVariable('CurrentRecipe.Speed');
```

Nested structures work the same way - return as nested JS objects:

```js
const config = await plc.readVariable('MachineConfig');
// -> { Network: { IP: "...", Subnet: "..." }, Motion: { MaxSpeed: 5000, ... } }

await plc.writeVariable('MachineConfig.Motion.MaxSpeed', 4500);
```

---

## 5. Working with arrays

### 1D arrays

Define `Setpoints : ARRAY[0..9] OF REAL`:

```js
// Read the whole array
const setpoints = await plc.readVariable('Setpoints');
// -> [1.5, 2.3, 4.7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

// Read one element
const sp3 = await plc.readVariable('Setpoints[3]');
// -> 0.0

// Write the whole array
await plc.writeVariable('Setpoints', [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]);

// Write one element
await plc.writeVariable('Setpoints[0]', 99.5);
```

### 2D arrays

Define `Matrix : ARRAY[0..2, 0..2] OF DINT`:

```js
const matrix = await plc.readVariable('Matrix');
// -> [[1, 2, 3], [4, 5, 6], [7, 8, 9]]

await plc.writeVariable('Matrix', [[10, 20, 30], [40, 50, 60], [70, 80, 90]]);
```

### Arrays of structures

Define `Recipes : ARRAY[0..9] OF RecipeData`:

```js
const allRecipes = await plc.readVariable('Recipes');
// -> [{ Speed: 100, Position: 0, ... }, { Speed: 200, Position: 100, ... }, ...]

// Access one
const r0 = await plc.readVariable('Recipes[0]');
// -> { Speed: 100, Position: 0, ... }

// Modify one member of one element
await plc.writeVariable('Recipes[3].Speed', 1800);
```

### BOOL arrays

These are bit-packed (16 bits per word, matching the controller). The library handles the packing transparently:

```js
const bits = await plc.readVariable('AlarmBits');
// -> [true, false, true, false, false, ...]

await plc.writeVariable('AlarmBits', [false, false, true, true, false, false, false, false]);
```

### Arrays of strings

These need element-by-element access internally (Omron quirk), but the API is the same:

```js
const names = await plc.readVariable('RecipeNames');
// -> ["WidgetA", "WidgetB", "WidgetC", ...]

await plc.writeVariable('RecipeNames', ['Alpha', 'Beta', 'Gamma']);
```

---

## 6. Verified writes

`writeVariable` is fire-and-forget. If the controller has a logical issue (out-of-range value on an enum, range check fails, etc.) you won't always know.

`verifiedWriteVariable` writes, reads back, compares, and retries up to N times:

```js
try {
  await plc.verifiedWriteVariable('TargetSpeed', 1500);
  console.log('Verified.');
} catch (err) {
  // After retries exhausted with mismatch
  console.error('Write could not be verified:', err.message);
}

// With a custom retry count (default is 2)
await plc.verifiedWriteVariable('TargetSpeed', 1500, 5);
```

Don't use this on tags that change continuously (counters, free-running timers) - the read-back will never match what you wrote.

---

## 7. Bulk read and write

Read or write many tags in one operation. Two strategies are available:

- **`'auto'`** (default): tries Multiple Service Packet (CIP service `0x0A`) which packs N requests into one wire frame. If the controller's firmware rejects MSP, transparently falls back to concurrent individual requests. The probe result is cached so subsequent calls don't repeat the negotiation.
- **`'concurrent'`**: always uses `Promise.all` over individual `readVariable` / `writeVariable` calls, bounded by the dispatcher's request semaphore (default cap 8 concurrent in-flight). Universal compatibility, more round-trips.

### Reading many tags

```js
const results = await plc.readVariables(
  ['Counter', 'TargetSpeed', 'AlarmCount', 'EnableFlag'],
  { mode: 'auto' }   // tries MSP first
);
// -> { Counter: 42, TargetSpeed: 1500, AlarmCount: 3, EnableFlag: true }
```

The same call works identically on an `NSeriesController` — `controller.readVariables([...])` queues through the controller's serialized op chain alongside every other operation. In production code, use the controller.

### Per-tag error reporting

By default, if some tags exist and others don't, you get per-tag results with `{__error: Error}` markers for the failures:

```js
const results = await plc.readVariables(
  ['Counter', 'NonexistentTag', 'TargetSpeed'],
  { partial: true }   // default
);
// -> { Counter: 42, NonexistentTag: { __error: CIPException... }, TargetSpeed: 1500 }

for (const [name, val] of Object.entries(results)) {
  if (val && val.__error) console.log(`${name}: ${val.__error.message}`);
  else                    console.log(`${name}: ${val}`);
}
```

Pass `partial: false` to reject the whole batch on the first error instead.

### Writing many tags

```js
const writeResults = await plc.writeVariables({
  Counter: 0,
  TargetSpeed: 1500,
  EnableFlag: true,
});
// -> { Counter: true, TargetSpeed: true, EnableFlag: true }
```

Bulk writes currently use concurrent individual requests under the hood (MSP-based atomic write is on the roadmap). The semaphore still caps concurrency.

### Forcing the concurrent path

If you have firmware that misbehaves under MSP or you want predictable latency:

```js
const r = await plc.readVariables(['A', 'B', 'C'], { mode: 'concurrent' });
```

### When NOT to use bulk operations

- **For single-tag reads.** `readVariable('Tag')` is faster than `readVariables(['Tag'])` because it skips the MSP wrapping.
- **For structures or arrays.** Those go through chunked-transfer paths that can't be packed into MSP. `readVariables` detects this and routes them to individual reads automatically, but if your whole batch is large structs, plain `Promise.all([plc.readVariable(...)...])` is just as efficient.
- **For atomic group writes.** `writeVariables` doesn't guarantee that all writes happen together. If you need that, pack the values into a structure on the PLC side and write the structure as one tag.

---

## 8. Variable discovery and the dictionary

You can read/write any published tag without discovery - the library learns the type on first access. But sometimes you want a complete list:

```js
await plc.updateVariableDictionary();

// All published variables
console.log(plc.variableList());
// -> ['Counter', 'TargetSpeed', '_CurrentTime', ...]

// User-defined only (no leading underscore)
console.log(plc.userVariableList());

// System variables (Omron-defined, start with _)
console.log(plc.systemVariableList());
```

`updateVariableDictionary()` is **expensive** - it makes one `get_attribute_all` request per tag, plus follow-up requests for every derived data type. A controller with 500 tags can take 10-30 seconds. Typically you'd call this once at startup.

**Resilient to unknown types.** If the controller has a variable whose CIP type the library doesn't recognize, the scan **skips it** instead of failing, and records it:

```js
const result = await plc.updateVariableDictionary();
console.log(result.skipped);        // [] normally, or [{ name, reason }, ...]
console.log(plc.skippedVariables);  // same list, also stored on the instance
```

Pass `{ skipUnknown: false }` to make it throw on the first unrecognized type instead (the old behavior). The Omron-specific types (ENUM, DATE, TIME, etc.) are all recognized as of 0.2.4, so skips should be rare.

---

## 9. Saving and loading the dictionary

To skip the discovery cost on every startup, persist the dictionary to disk:

```js
await plc.connect();
await plc.loadDictionaryFileIfPresent('plc-dictionary.json');
//   If the file exists, loads it.
//   If not, runs updateVariableDictionary() and saves it.

// Later, after the project changes on the PLC, just delete the file:
//   rm plc-dictionary.json
// Next run will re-discover and re-save.
```

Manual control:

```js
await plc.updateVariableDictionary();
await plc.saveCurrentDictionary('plc-dictionary.json');

// On the next run, instead of update:
await plc.loadDictionaryFile('plc-dictionary.json');
```

**Important caveat:** If you change a variable's type on the controller (e.g., `Counter` from `DINT` to `LINT`) but don't refresh the saved dictionary, you'll get mysterious byte-decoding errors. Delete the JSON file whenever the controller program changes.

---

## 10. Monitored variables (polling)

`MonitoredVariable` polls a tag at a fixed interval and emits a `'change'` event when the value differs from the previous read.

```js
const { NSeriesController, MonitoredVariable } = require('omron-eip');

const plc = new NSeriesController({ host: '192.168.1.100' });
await plc.connect();

const counter = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 100 });

counter.on('change', (newValue, prevValue) => {
  console.log(`Counter: ${prevValue} -> ${newValue}`);
});

counter.on('error', err => {
  console.error('Monitor failed to read:', err.message);
});

// Read the latest cached value at any time (no PLC round-trip)
console.log('Current cached value:', counter.value);

// Write through the monitor (uses verifiedWriteVariable under the hood)
await counter.setValue(0);

// Stop polling (releases the cache slot)
counter.cancel();
```

**Singleton behavior:** If you construct a `MonitoredVariable` for the same `(controller, variableName)` pair twice, you get back the same instance. The shorter `refreshTimeMs` wins. This prevents redundant polls when many parts of your app subscribe to the same tag.

```js
const a = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 500 });
const b = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 100 });
console.log(a === b);            // true
console.log(a.refreshTimeMs);    // 100 (the shorter interval won)
```

**Picking a refresh interval:**

- **Display / UI**: 100-500 ms
- **Alarms / events**: 50-100 ms
- **Logging slow processes**: 1000+ ms

Don't go below ~20 ms - you'll just flood the PLC and get `RESOURCE_UNAVAILABLE` retries.

### Async iteration

`MonitoredVariable` is also an async iterable. Each iteration yields the next **changed** value (it's a value stream, not a poll stream — values that match the previous read aren't emitted):

```js
const monitor = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 100 });

for await (const value of monitor) {
  console.log('Counter =', value);
  if (value > 100) break;   // breaking out of the loop is fine; cleanup is automatic
}

monitor.cancel();   // still call this when you're done with the monitor
```

Errors from the underlying read throw out of the `for await` loop, so wrap in `try/catch` if you want to keep iterating after one bad read.

### Automatic cleanup if you forget cancel()

If a `MonitoredVariable` gets garbage-collected without `cancel()` being called, a `FinalizationRegistry` clears its timer and removes its registry entry automatically. This prevents silent timer leakage in long-running services where you might create transient monitors. That said, **always call `cancel()` explicitly when you're done** — GC timing is not guaranteed and you don't want a poll firing one last time on a stale dispatcher.

---

## 11. NSeriesController - auto-reconnect and keep-alive

For anything long-running, use `NSeriesController` instead of `NSeries`. It:

- **Auto-reconnects** on socket errors and dispatcher close events.
- **Keep-alive** option: periodic `list_services` heartbeat keeps connection-tracking firewalls happy.
- **Serializes operations** on an internal Promise chain - reconnect can't race against in-flight reads.
- **EventEmitter API** for connection lifecycle.

```js
const { NSeriesController } = require('omron-eip');

const plc = new NSeriesController({
  host: '192.168.1.100',
  connectionTimeoutMs: 5000,
  requestTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  maxReconnectAttempts: Infinity,   // never give up
  keepAlive: true,
  keepAliveIntervalMs: 5000,
});

plc.on('connect',    ()    => console.log('connected'));
plc.on('disconnect', ()    => console.log('disconnected'));
plc.on('reconnect',  (n)   => console.log(`reconnected on attempt ${n}`));
plc.on('error',      (err) => console.error('controller error:', err.message));
plc.on('dispatcherError', (err) => console.error('dispatcher error:', err.message));

await plc.connect();

// Use exactly like NSeries
const counter = await plc.readVariable('Counter');
await plc.writeVariable('Counter', counter + 1);

// Clean shutdown
await plc.close();
```

### Constructor options

| Option | Default | Description |
|---|---|---|
| `host` | (required at connect) | PLC IP address or hostname |
| `connectionTimeoutMs` | `5000` | TCP connect timeout |
| `requestTimeoutMs` | `10000` | Per-request response timeout |
| `reconnectDelayMs` | `1000` | Base delay for the first reconnect attempt; also the floor for non-jittered mode |
| `reconnectMaxDelayMs` | `30000` | Ceiling for backoff delay |
| `reconnectBackoffJitter` | `true` | Exponential backoff with full jitter (prevents thundering-herd reconnect storms) |
| `maxReconnectAttempts` | `Infinity` | Set to `0` to disable auto-reconnect |
| `keepAlive` | `false` | Send periodic `list_services` heartbeat |
| `keepAliveIntervalMs` | `5000` | Heartbeat interval |
| `autoConnect` | `false` | If `true`, connects immediately in the constructor |
| `maxConcurrentRequests` | `8` | In-flight CIP request cap; `0` or `Infinity` disables limiting |
| `useConnectedMessaging` | `false` | Try Class 3 connected explicit messaging (see section 12) |
| `logger` | `null` | `{debug, info, warn, error}` callbacks; missing methods become no-ops |

**A note on reconnect backoff:** with `reconnectBackoffJitter: true`, the delay before attempt N is a uniform-random number between 0 and `min(reconnectMaxDelayMs, reconnectDelayMs * 2^(N-1))`. The first retry typically waits 0–1 second; by the tenth attempt it's bounded at 30 seconds. This is the "full jitter" algorithm recommended for clients reconnecting to a shared resource — it avoids the failure mode where many clients all reconnect at the same tick and trigger `RESOURCE_UNAVAILABLE` on the PLC.

### Disabling auto-reconnect

```js
const plc = new NSeriesController({
  host: '192.168.1.100',
  maxReconnectAttempts: 0,   // fail-fast on disconnect
});
```

---

## 12. Class 3 connected explicit messaging

CIP supports two messaging modes for explicit requests: **UCMM** (unconnected — the default) and **Class 3 connected**. UCMM is universal and is the validated production path. Class 3 opens a persistent connection up front, which can reduce CIP routing overhead on some controllers and topologies.

Enabling it is a single option. The library negotiates the right Forward_Open format automatically — Omron NX/NJ firmware rejects the Large_Forward_Open (0x5B) that many CIP devices use, so the library tries the classic Forward_Open (0x54) first and uses whichever the controller accepts. If none are accepted, every operation transparently falls back to UCMM, so enabling this never breaks anything.

```js
const plc = new NSeriesController({
  host: '192.168.1.100',
  useConnectedMessaging: true,   // opt in
});

await plc.connect();
// All read/write calls now go through the Class 3 path if the controller accepted it.
```

Check whether the connection succeeded with the introspection helpers on `NSeries`
(via `controller.plc` for a controller):

```js
const ns = plc.plc;                  // the underlying NSeries
if (ns && ns.usingConnectedMessaging()) {
  console.log('Class 3 connected messaging active');
} else {
  console.log('Using UCMM', ns ? ns.connectedMessagingError : '(not connected)');
}
```

**Tuning (optional).** Pass `connectedMessagingOptions` to override Forward_Open parameters
or the negotiation list:

```js
const plc = new NSeries({
  host: '192.168.1.100',
  useConnectedMessaging: true,
  connectedMessagingOptions: {
    connectionSize: 500,
    rpiMicroseconds: 2000000,
    useLargeForwardOpen: false,            // pin the Small Forward_Open
    // forwardOpenVariants: [ ... ]        // or override the whole negotiation list
  },
});
```

**Gotchas to be aware of:**

- **A single Class 3 connection is serialized.** Only one connected request is on the wire at a time — the controller processes them in order and the library queues concurrent callers. UCMM, by contrast, can run many requests in parallel. On a direct connection, this means UCMM actually outperforms Class 3 on aggregate throughput (measured on an NX102: ~500 ops/sec UCMM vs ~200 ops/sec Class 3). High concurrency does not parallelize on a single Class 3 connection — it just queues.
- **Large array reads fail on Class 3.** Reading a tag larger than the negotiated connection size (default 500 bytes) returns `REPLY_DATA_TOO_LARGE` (CIP status 0x11). The library's automatic chunking sizes chunks against the unconnected limit, which exceeds the connected limit. If you need to read large arrays (>~100 elements depending on element size), use UCMM. Small bulk reads, scalar reads/writes, and structure reads all work fine.
- **Forward_Open negotiation is automatic.** Omron NX/NJ accept the classic Forward_Open (0x54) but reject the Large_Forward_Open (0x5B) with status 0x01/0x0801. The library tries variants in order and uses whichever the controller accepts, so you don't have to know this — but the negotiation logging will tell you which variant was used (`small(0x54)` on NX/NJ).

**When to enable Class 3:** when CIP routing overhead is significant — for example when reaching a controller behind a routing gateway or comms module, or when a specific controller throttles UCMM. In those topologies Class 3 resolves the path once at Forward_Open and reuses it, which can be much faster. For a direct PC-to-PLC connection, **UCMM (the default) is the right choice** — it's faster, has no large-array limitation, and parallelizes naturally.

---

## 13. UDP broadcast discovery

Find every reachable EIP device on your subnet without knowing IPs in advance:

```js
const { discoverDevices } = require('omron-eip');

const devices = await discoverDevices({
  broadcastAddress: '192.168.1.255',  // subnet broadcast (or omit for 255.255.255.255)
  timeoutMs: 2000,                    // how long to listen for replies
});

for (const d of devices) {
  console.log(`${d.ip}: ${d.productName} (vendor 0x${d.vendorId.toString(16)})`);
}
```

Returned fields per device:

```js
{
  ip: '192.168.1.100',
  port: 44818,
  vendorId: 47,                       // Omron is 0x002F
  deviceType: 12,                     // Communications Adapter, PLC, etc.
  productCode: 1234,
  revisionMajor: 1,
  revisionMinor: 30,
  status: 96,                         // EIP device status bitfield
  serialNumber: 0xDEADBEEF,
  productName: 'NX102-9000',
  state: 3,                           // operational state
}
```

Good for commissioning UIs and Node-RED config dropdowns. Doesn't require any prior session; sends one UDP broadcast to port 44818 and collects replies.

---

## 14. TypeScript users

The library ships with `.d.ts` declarations covering the full public surface, so TypeScript projects get type hints, autocomplete, and compile-time checks for free:

```ts
import { NSeriesController, MonitoredVariable, CIPException } from 'omron-eip';

const plc = new NSeriesController({
  host: '192.168.1.100',
  reconnectBackoffJitter: true,
});

await plc.connect();

const counter: number = await plc.readVariable('Counter');
await plc.writeVariable('Counter', counter + 1);

try {
  await plc.readVariable('NonexistentTag');
} catch (err) {
  if (err instanceof CIPException) {
    console.error('CIP error:', err.statusCode);
  }
}
```

Bulk results and async iteration are typed too:

```ts
import type { BulkResult } from 'omron-eip';

const results: BulkResult = await plc.readVariables(['A', 'B']);

const monitor = new MonitoredVariable(plc, 'Counter');
for await (const value of monitor) {
  console.log(value);
}
```

The declarations are at `lib/index.d.ts` (and one per submodule). The `types` field in `package.json` points TypeScript at them automatically.

---

## 15. Non-NX/NJ Omron devices

Four wrappers for non-PLC Omron devices that speak EtherNet/IP. **These are ported from aphyt but not yet tested against real hardware in this port** — the wire format matches aphyt's implementation, so they should work, but field-validate before relying on them in production.

### TCP/IP Interface Object (standard CIP class 0xF5)

Works on any EIP device. Read IP configuration, hostname, encapsulation inactivity timeout:

```js
const { NSeries, TCPInterfaceObject } = require('omron-eip');

const plc = new NSeries({ host: '192.168.1.100' });
await plc.connect();

const tcp = new TCPInterfaceObject(plc.dispatcher);
const config = await tcp.getInterfaceConfiguration();
// -> { ipAddress: '192.168.1.100', subnetMask: '255.255.255.0', defaultGateway: '...', ... }

const timeout = await tcp.getEncapsulationInactivityTimeout();
console.log('Session timeout (seconds):', timeout);

await plc.close();
```

### F4 vision sensor

```js
const { F4Series } = require('omron-eip');

const cam = new F4Series();
await cam.connect('192.168.1.50');
await cam.goOnline();

await cam.triggerInspection();
await cam.getCameraStatus();
console.log('Inspection passed:', cam.statusInspectionStatus());

// Attribute storage maps: numeric "registers" 1..200 for each type
await cam.setInt(1, 42);
const x = await cam.getInt(1);

await cam.close();
```

### K6PM-TH thermal sensor

```js
const { K6PMTH } = require('omron-eip');

const sensor = new K6PMTH();
await sensor.connect('192.168.1.51');

const count = await sensor.numberOfConnectedSensors();
console.log(`${count} thermal sensors connected`);

const tempC = await sensor.internalTemperature(1);     // sensor #1
console.log(`Sensor 1 internal temp: ${tempC} °C`);

const pixels = await sensor.pixelTemperatures(1);
// -> 16x64 matrix of temperatures in °C

await sensor.close();
```

### V4 barcode reader

```js
const { V4Series } = require('omron-eip');

const scanner = new V4Series();
await scanner.connect('192.168.1.52');

const barcode = await scanner.readExecute();   // sends "< >" command
console.log('Scanned:', barcode);

await scanner.close();
```

---

## 16. Error handling

### CIPException

Any nonzero CIP general status throws a `CIPException`:

```js
const { CIPException } = require('omron-eip');

try {
  await plc.readVariable('NonexistentTag');
} catch (err) {
  if (err instanceof CIPException) {
    console.error('CIP error:', err.message);
    console.error('Status code:', err.statusCode);           // '04'
    console.error('Extended status:', err.extendedStatusCode); // '' if none
  } else {
    throw err;  // socket error, timeout, etc.
  }
}
```

Most common codes you'll see:

| Code | What it means |
|---|---|
| `0x04` | `PATH_SEGMENT_ERROR` - variable doesn't exist, isn't published, or wrong name |
| `0x05` | `PATH_DESTINATION_UNKNOWN` |
| `0x0C` | `OBJECT_STATE_CONFLICT` - usually controller is in a state that doesn't permit the operation |
| `0x11` | `REPLY_DATA_TOO_LARGE` |
| `0x13` | `NOT_ENOUGH_DATA` - request was malformed |
| `0x15` | `TOO_MUCH_DATA` - write payload exceeded what the type can hold |
| `0x1F` | `VENDOR_SPECIFIC_ERROR` - check `extendedStatus` |
| `0x22 0x80` | Type mismatch - the value you sent doesn't match the variable's declared type |

`0x02` (`RESOURCE_UNAVAILABLE`) is automatically retried inside the dispatcher and will only surface as an exception if the controller is unavailable for longer than `resourceUnavailableRetries * resourceUnavailableBackoffMs`.

### TypeError / RangeError from `writeVariable`

Since 0.2.0, every scalar `fromValue()` validates its input before packing. You'll get clear errors for mismatched JS types or out-of-range values, **before** any data goes on the wire:

```js
try {
  await plc.writeVariable('TestInt', 'not a number');
} catch (err) {
  // TypeError: CIPInteger.fromValue: expected an integer Number, got string
}

try {
  await plc.writeVariable('TestUsint', 500);
} catch (err) {
  // RangeError: CIPUnsignedShortInteger.fromValue: value 500 out of range [0, 255]
}
```

Catch them like any other Node `Error`. They're not `CIPException` — that class is reserved for errors that came back from the PLC.

### Network errors

```js
try {
  await plc.connect();
} catch (err) {
  if (err.code === 'ECONNREFUSED') console.error('PLC not reachable');
  else if (err.code === 'EHOSTUNREACH') console.error('No route to PLC');
  else if (/timed out/.test(err.message)) console.error('PLC not responding');
  else throw err;
}
```

### Timeouts

Per-request timeout is configurable on the dispatcher (default 10 s):

```js
const plc = new NSeries({
  host: '192.168.1.100',
  requestTimeoutMs: 30000,   // 30 seconds - useful for big array reads
});
```

---

## 17. Low-level CIP access

For talking to non-NX/NJ EtherNet/IP devices that don't have a built-in wrapper, use the dispatcher directly. Section 15 covers the Omron-specific wrappers (`F4Series`, `K6PMTH`, `V4Series`, `TCPInterfaceObject`) which are built on the same primitives shown below.

### Reading a CIP class/instance/attribute

```js
const { EIPDispatcher, addressRequestPathSegment, CIPUnsignedInteger } = require('omron-eip');

const d = new EIPDispatcher({ host: '192.168.1.50' });
await d.connectExplicit();
await d.registerSession();

// Read attribute 100 from instance 1 of class 0x0374 (K6PM-TH main unit)
const path = addressRequestPathSegment({
  classId: Buffer.from([0x74, 0x03]),    // 0x0374 little-endian
  instanceId: Buffer.from([0x01]),
  attributeId: Buffer.from([0x64]),
});
const reply = await d.getAttributeSingleService(path);

const value = new CIPUnsignedInteger();
value.data = reply.replyData;
console.log('Status word:', value.value());

await d.closeExplicit();
```

### Writing a CIP attribute

```js
const { CIPInteger } = require('omron-eip');

const path = addressRequestPathSegment({
  classId: Buffer.from([0x69, 0x00]),
  instanceId: Buffer.from([0x01]),
  attributeId: Buffer.from([0x01]),
});

const value = new CIPInteger();
value.fromValue(1234);
await d.setAttributeSingleService(path, value.data);
```

### Custom service codes (vendor-specific)

Some Omron products use vendor-specific service codes. Build a `CIPRequest` directly:

```js
const { CIPRequest } = require('omron-eip');

const request = new CIPRequest(
  Buffer.from([0x45]),               // V4 series "execute command" service
  addressRequestPathSegment({
    classId: Buffer.from([0x68, 0x00]),
    instanceId: Buffer.from([0x01]),
    attributeId: Buffer.from([0x01]),
  }),
  /* request data: */ Buffer.from('<command>')
);
const reply = await d.executeCipCommand(request);
```

---

## 18. Complete API reference

### `NSeries`

The basic, non-resilient client. Use for one-shot scripts.

#### `new NSeries(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `null` | PLC IP address |
| `connectionTimeoutMs` | `number` | `5000` | TCP connect timeout |
| `requestTimeoutMs` | `number` | `10000` | Per-request response timeout |
| `maxConcurrentRequests` | `number` | `8` | In-flight CIP request cap; `0` or `Infinity` disables |
| `useConnectedMessaging` | `boolean` | `false` | Try Class 3 connected explicit messaging (falls back to UCMM if rejected) |
| `connectedMessagingOptions` | `object` | `{}` | Advanced Forward_Open tuning (RPI, connection size, `useLargeForwardOpen`, `forwardOpenVariants`, etc.). See section 12. |
| `logger` | `object` | `null` | `{debug, info, warn, error}` callbacks; missing methods become no-ops |

#### Methods

| Method | Returns | Description |
|---|---|---|
| `connect(host?)` | `Promise<void>` | Open TCP, register session |
| `close()` | `Promise<void>` | Close cleanly |
| `connectExplicit(host, timeoutMs)` | `Promise<void>` | Alias for `connect`, aphyt-compatible |
| `closeExplicit()` | `Promise<void>` | Alias for `close` |
| `registerSession()` | `Promise<void>` | No-op (handled inside `connect`); kept for compat |
| `readVariable(name)` | `Promise<any>` | Read by symbolic name |
| `writeVariable(name, data)` | `Promise<void>` | Write by symbolic name |
| `verifiedWriteVariable(name, data, retry=2)` | `Promise<void>` | Write + read-back + retry |
| `readVariables(names[], opts?)` | `Promise<{name: value}>` | Bulk read; auto MSP/concurrent |
| `writeVariables({pairs}, opts?)` | `Promise<{name: true \| {__error}}>` | Bulk write; concurrent |
| `updateVariableDictionary(opts?)` | `Promise<{skipped}>` | Discover all tags (expensive). `opts.skipUnknown` (default true) skips unrecognized types; skips also recorded on `plc.skippedVariables` |
| `variableList()` | `string[]` | All known tag names |
| `userVariableList()` | `string[]` | User tags (no leading `_`) |
| `systemVariableList()` | `string[]` | System tags |
| `saveCurrentDictionary(filename)` | `Promise<void>` | Persist dictionary as JSON |
| `loadDictionaryFile(filename)` | `Promise<void>` | Load dictionary from JSON |
| `loadDictionaryFileIfPresent(filename)` | `Promise<void>` | Load if exists, else discover+save |
| `usingConnectedMessaging()` | `boolean` | True if a Class 3 connection is currently open; false means UCMM |
| `connectedMessagingError` | `Error \| null` | (Property) The Forward_Open rejection that caused fallback to UCMM, or `null` |

### `NSeriesController`

Resilient wrapper. Use for production / long-running services.

#### `new NSeriesController(options)`

All `NSeries` options, plus:

| Option | Type | Default | Description |
|---|---|---|---|
| `reconnectDelayMs` | `number` | `1000` | Base for backoff (also the floor for non-jittered mode) |
| `reconnectMaxDelayMs` | `number` | `30000` | Ceiling for backoff delay |
| `reconnectBackoffJitter` | `boolean` | `true` | Exponential backoff with full jitter |
| `maxReconnectAttempts` | `number` | `Infinity` | Set to `0` to disable auto-reconnect |
| `keepAlive` | `boolean` | `false` | Periodic `list_services` heartbeat |
| `keepAliveIntervalMs` | `number` | `5000` | Heartbeat interval |
| `autoConnect` | `boolean` | `false` | Connect immediately in constructor |

#### Methods

Same as `NSeries` for `readVariable`, `writeVariable`, `verifiedWriteVariable`, `readVariables`, `writeVariables`, `updateVariableDictionary`, list methods, and dictionary persistence.

| Additional method | Returns | Description |
|---|---|---|
| `connect(host?)` | `Promise<void>` | Connect and start keep-alive if enabled |
| `close()` | `Promise<void>` | Close and stop all background activity |

#### Events

| Event | Args | When |
|---|---|---|
| `connect` | - | Initial connection succeeded |
| `disconnect` | - | Socket closed (clean or abrupt) |
| `reconnect` | `(attemptNumber)` | Reconnection succeeded |
| `error` | `(Error)` | Connection-level error |
| `dispatcherError` | `(Error)` | Socket-level error (often followed by reconnect) |

### `MonitoredVariable`

Polled tag with change events.

#### `new MonitoredVariable(controller, variableName, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `refreshTimeMs` | `number` | `50` | Polling interval |
| `autoStart` | `boolean` | `true` | Start the timer immediately |

#### Properties and methods

| Member | Type | Description |
|---|---|---|
| `.value` | getter | Last-read cached value (no PLC round-trip) |
| `.setValue(v)` | `Promise<void>` | Write through, update cache |
| `.start()` | `void` | Start (or resume) polling |
| `.cancel()` | `void` | Stop polling, release the singleton slot |
| `[Symbol.asyncIterator]()` | `AsyncIterator` | Use the monitor as `for await (const v of monitor) { ... }` |
| `.asyncIterator()` | `AsyncIterator` | Same as above (named alternative) |

#### Events

| Event | Args | When |
|---|---|---|
| `change` | `(newValue, prevValue)` | The polled value differs from the previous read |
| `error` | `(Error)` | A poll failed |

### `EIPDispatcher`

Low-level TCP/EIP/CIP transport. Use for non-NX/NJ devices or custom CIP services.

#### Methods (selected)

| Method | Description |
|---|---|
| `connectExplicit(host, timeoutMs?)` | Open TCP |
| `closeExplicit()` | Close TCP |
| `registerSession()` | Register EIP session |
| `listServices()` / `listIdentity()` / `listInterfaces()` | EIP discovery commands |
| `readTagService(path, n=1)` | CIP service 0x4C |
| `writeTagService(path, commonFormat, n=1)` | CIP service 0x4D |
| `getAttributeAllService(path)` | CIP service 0x01 |
| `getAttributeSingleService(path)` | CIP service 0x0E |
| `setAttributeSingleService(path, data)` | CIP service 0x10 |
| `getInstanceList(start, count, userDefined)` | Omron CIP service 0x5F |
| `executeCipCommand(cipRequest)` | Send any custom CIP request |

### Path builders

```js
const { addressRequestPathSegment, variableRequestPathSegment } = require('omron-eip');

// Logical segment - for class/instance/attribute access
const p1 = addressRequestPathSegment({
  classId: Buffer.from([0x6a]),
  instanceId: Buffer.from([0x01]),
  attributeId: Buffer.from([0x02]),
});

// Symbolic segment - for tag names
const p2 = variableRequestPathSegment('MyStruct.Field[3].Sub');
```

### CIP data types

Importable for low-level use (`getAttributeSingleService` returns raw bytes; wrap them with the right type):

```js
const {
  CIPBoolean,            // 0xC1  - boolean
  CIPShortInteger,       // 0xC2  - SINT, number
  CIPInteger,            // 0xC3  - INT, number
  CIPDoubleInteger,      // 0xC4  - DINT, number
  CIPLongInteger,        // 0xC5  - LINT, BigInt
  CIPUnsignedShortInteger,// 0xC6 - USINT
  CIPUnsignedInteger,    // 0xC7  - UINT
  CIPUnsignedDoubleInteger,// 0xC8 - UDINT
  CIPUnsignedLongInteger,// 0xC9  - ULINT, BigInt
  CIPReal,               // 0xCA  - REAL, number
  CIPLongReal,           // 0xCB  - LREAL, number
  CIPString,             // 0xD0
  CIPByte, CIPWord,
  CIPDoubleWord, CIPLongWord,
  CIPTime,
  CIPStructure,          // 0xA2
  CIPArray,              // 0xA3
  CIPAbbreviatedStructure,// 0xA0
} = require('omron-eip');
```

Each has:
- `static dataTypeCode` - the 1-byte CIP code
- `instance.data` - the wire bytes
- `instance.size` - byte length
- `instance.value()` - extract as JS native
- `instance.fromValue(v)` - set from JS native

### Helpers

| Export | Type | Use |
|---|---|---|
| `CIP_STATUS` | `Object` | Status-code -> `[name, description]` table |
| `CIPException` | `Error` subclass | Thrown on nonzero CIP status |
| `CIPService` | `Object` | Service-code constants |
| `EIP_PORT` | `44818` | EtherNet/IP TCP port |
| `MAXIMUM_LENGTH` | `502` | UCMM maximum frame size |
| `cipCrc16(buffer)` | `Buffer` | CIP CRC-16 (poly 0xA001) |
| `createTypeInstance(code)` | `CIPDataType\|null` | Instantiate by 1-byte type code |
| `getDataTypeClass(code)` | `class\|null` | Look up a type class by code |
| `registerType(class)` | - | Register a custom CIP data type subclass |
| `Semaphore` | `class` | Bounded-concurrency primitive (used internally for the in-flight cap) |
| `computeBackoffMs(attempt, base, max)` | `number` | Exponential backoff with full jitter |
| `deepEqual(a, b)` | `boolean` | Structural equality across primitives, BigInt, Buffer, plain objects, arrays |

### Bulk operations

```js
plc.readVariables(names: string[], opts?: ReadVariablesOptions): Promise<BulkResult>
plc.writeVariables(pairs: Record<string, any>, opts?: ReadVariablesOptions): Promise<BulkResult>
```

`ReadVariablesOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `'auto' \| 'multipleService' \| 'concurrent'` | `'auto'` | MSP with fallback, force MSP, or always concurrent |
| `partial` | `boolean` | `true` | Tag-level failures appear as `{__error: Error}` instead of rejecting the whole batch |

### Multiple Service Packet (CIP 0x0A) — low-level access

```js
const { buildMultipleServiceRequest, decodeMultipleServiceReply, MESSAGE_ROUTER_PATH } = require('omron-eip');

const wrappedRequest = buildMultipleServiceRequest([req1, req2, req3]);
const outerReply = await dispatcher.executeCipCommand(wrappedRequest);
const innerReplies = decodeMultipleServiceReply(outerReply.replyData);
```

### Device discovery

```js
discoverDevices(opts?: {
  broadcastAddress?: string;   // default '255.255.255.255'
  timeoutMs?: number;          // default 2000
  port?: number;               // default 44818
}): Promise<DiscoveredDevice[]>
```

Each `DiscoveredDevice` has: `ip, port, vendorId, deviceType, productCode, revisionMajor, revisionMinor, status, serialNumber, productName, state`.

### Connected (Class 3) explicit messaging — low-level access

```js
const { ConnectedSession } = require('omron-eip');

const session = new ConnectedSession(dispatcher, {
  rpiMicroseconds: 2000000,      // default 2 seconds
  connectionSize: 500,           // max bytes per packet
  timeoutMultiplier: 2,
  // useLargeForwardOpen: false, // pin a variant; omit to auto-negotiate
  // forwardOpenVariants: [...],  // override the negotiation list
});
await session.open();            // negotiates and opens; throws if all variants rejected
dispatcher.connectedSession = session;
// ...
await session.close();
```

`open()` tries the configured Forward_Open variants in order and uses the first the
controller accepts. After it resolves, `session.params` holds the accepted parameter set,
and `session.otConnectionId` / `session.toConnectionId` hold the negotiated connection IDs.

Usually you don't touch this directly; pass `useConnectedMessaging: true` to `NSeries` or `NSeriesController` instead.

### Product wrappers

| Class | Description |
|---|---|
| `TCPInterfaceObject(dispatcher)` | Standard CIP class 0xF5 — read/write IP config, hostname, encapsulation timeout |
| `F4Series()` | Omron F4 vision sensor — control register, status bits, attribute storage maps |
| `K6PMTH()` | Omron K6PM-TH thermal sensor — main unit, per-sensor monitor, pixel temps |
| `V4Series()` | Omron V4 barcode reader — vendor-specific command execution |

All three product classes follow the same lifecycle pattern as `NSeries`: `await x.connect(host)` then operate, then `await x.close()`. See section 15 for examples.

---

## You're done

Five runnable example files in `examples/` cover the most common patterns:

```bash
node examples/basic.js       192.168.1.100
node examples/monitored.js   192.168.1.100 Counter
node examples/controller.js  192.168.1.100
node examples/bulk.js        192.168.1.100
node examples/discovery.js   192.168.1.255
```

Once you've got those working against your PLC, you've exercised every major feature.
