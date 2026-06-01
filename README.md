# omron-eip

A Node.js EtherNet/IP client for **Omron NX/NJ Sysmac controllers**, using symbolic tag names
(no manual offsets or memory maps). Zero runtime dependencies.

This library was built to be used with my **Node-RED** package
(`node-red-contrib-omron-eip`), which wraps it in drag-and-drop read/write nodes. However, it
works perfectly well as a **standalone library** — you can `require('omron-eip')` in any Node.js
project and talk to a controller directly.


## Tested hardware

This library has been tested against real controllers — **NX1P2**, **NX501**, and **NX102** —
using a bench suite that ramps request rates until latency degrades and measures how many tags
can be read per polling interval. All three pass with zero errors across reads, writes, bulk
operations, structures, and arrays. Highlights (direct connection, UCMM):


> **UCMM vs Class 3, at a glance:** on a direct connection UCMM is faster and has no large-array
> limit. Under Class 3, single-array reads above a few hundred elements fail with
> `REPLY_DATA_TOO_LARGE` on every controller tested — another reason UCMM is the default. See
> the benchmark doc for the full picture.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Messaging modes: UCMM vs Class 3](#messaging-modes-ucmm-vs-class-3)
- [Reading tags](#reading-tags)
- [Writing tags](#writing-tags)
- [Supported data types](#supported-data-types)
- [Structures, arrays, and nested addressing](#structures-arrays-and-nested-addressing)
- [Bulk reads and writes](#bulk-reads-and-writes)
- [Verified writes](#verified-writes)
- [Monitoring tags for changes](#monitoring-tags-for-changes)
- [Connection handling, disconnects, and reconnects](#connection-handling-disconnects-and-reconnects)
- [Variable discovery](#variable-discovery)
- [Device discovery](#device-discovery)
- [Error handling](#error-handling)
- [Full API summary](#full-api-summary)
- [More documentation](#more-documentation)
- [License](#license)

---

## Install

```bash
npm install omron-eip
```

Requires Node.js 16 or newer. No other dependencies.

For a tag to be reachable, in Sysmac Studio it must be a **global variable** with **Network
Publish = Publish Only** (or Input/Output), and the project must be **transferred** to the
controller.

---

## Quick start

```js
const { NSeries } = require('omron-eip');

async function main() {
  const plc = new NSeries({ host: '192.168.250.1' });
  await plc.connect();

  const count = await plc.readVariable('Counter');     // -> number
  await plc.writeVariable('Setpoint', 1500);

  await plc.close();
}

main().catch(console.error);
```

For long-running applications use `NSeriesController` instead — same methods, plus automatic
reconnection (see [Connection handling](#connection-handling-disconnects-and-reconnects)).

---

## Messaging modes: UCMM vs Class 3

EtherNet/IP explicit messaging can be done two ways, and this library supports both. You pick
when you construct the client.

**UCMM (Unconnected Messaging) — the default and recommended mode.**
Each request is sent unconnected, with no session to set up or tear down. It is the right
choice for almost every setup, especially a direct PC-to-PLC connection:

- fastest for high-rate and parallel reads,
- requests can run concurrently,
- no limit on large array reads,
- nothing to negotiate.

```js
const plc = new NSeries({ host: '192.168.250.1' });   // UCMM by default
```

**Class 3 (Connected Messaging) — optional.**
Opens a persistent CIP connection (via Forward_Open) and sends requests over it. This only
helps when traffic travels through a **routing gateway, a comms module, or across a backplane**,
where keeping a connection open avoids re-resolving the route on every request.

```js
const plc = new NSeries({ host: '192.168.250.1', useConnectedMessaging: true });
await plc.connect();

if (plc.usingConnectedMessaging()) {
  // Class 3 is active
} else {
  // The controller declined Class 3; the library fell back to UCMM automatically.
  console.log('reason:', plc.connectedMessagingError);
}
```

Notes on Class 3:

- The library **auto-negotiates** the Forward_Open variant. Omron rejects the *Large*
  Forward_Open (0x5B) and accepts the classic one (0x54); the library handles this for you.
- If the controller refuses Class 3 for any reason, the library **silently falls back to
  UCMM**, so enabling it can never break a connection — at worst it just doesn't help.
- On a **direct connection, UCMM is faster.** A single Class 3 connection serializes requests,
  and it cannot read very large arrays (the reply can exceed the connection's data limit). Use
  Class 3 only if your topology specifically benefits from it.

Introspection: `plc.usingConnectedMessaging()` returns whether Class 3 is currently active, and
`plc.connectedMessagingError` holds the reason if a requested Class 3 connection fell back.

---

## Reading tags

`readVariable(name)` returns the tag's value as a native JavaScript value. You never declare
the type — the library determines it from the controller and decodes accordingly.

```js
const a = await plc.readVariable('Counter');          // DINT   -> number
const b = await plc.readVariable('Temperature');      // REAL   -> number
const c = await plc.readVariable('Running');          // BOOL   -> boolean
const d = await plc.readVariable('RecipeName');       // STRING -> string
const e = await plc.readVariable('BigCount');         // LINT   -> BigInt
```

To read many tags at once, use [bulk reads](#bulk-reads-and-writes) rather than awaiting many
single calls.

---

## Writing tags

`writeVariable(name, value)` takes a native JavaScript value and encodes it for the tag's
actual type:

```js
await plc.writeVariable('Setpoint', 1500);              // number  -> DINT/INT/...
await plc.writeVariable('Temperature', 21.5);           // number  -> REAL
await plc.writeVariable('Enable', true);                // boolean -> BOOL
await plc.writeVariable('RecipeName', 'BATCH_07');      // string  -> STRING
await plc.writeVariable('BigCount', 9007199254740993n); // BigInt  -> LINT
```

If you need a guarantee the value landed, use a [verified write](#verified-writes). To change a
single member of a structure, write the member directly rather than rewriting the whole
structure.

---

## Supported data types

The library maps every Omron/CIP type to a natural JavaScript value, in both directions.

| Sysmac / Omron type | CIP code | JavaScript value |
|---|---|---|
| BOOL | `0xC1` | `boolean` |
| SINT / INT / DINT | `0xC2` / `0xC3` / `0xC4` | `number` |
| LINT | `0xC5` | `BigInt` |
| USINT / UINT / UDINT | `0xC6` / `0xC7` / `0xC8` | `number` |
| ULINT | `0xC9` | `BigInt` |
| REAL | `0xCA` | `number` |
| LREAL | `0xCB` | `number` |
| STRING | `0xD0` | `string` (up to the tag's max length) |
| BYTE / WORD / DWORD | `0xD1` / `0xD2` / `0xD3` | `Buffer` |
| LWORD | `0xD4` | `Buffer` |
| Structure (UDT) | `0xA2` | plain JS object `{ member: value, ... }` |
| Array | `0xA3` | JS array (nested for multi-dimensional) |
| **Omron ENUM** | `0x07` | `number` (the enum's integer value) |
| **Omron DATE** | `0x08` | reads as JS `Date`; write a `Date`, or nanoseconds since 1970 as `BigInt`/`number` |
| **Omron TIME** | `0x09` | reads as `BigInt` nanoseconds; write `BigInt` (or `number`) nanoseconds |
| **Omron DATE_AND_TIME** | `0x0A` | reads as JS `Date`; write a `Date`, or nanoseconds since 1970 as `BigInt`/`number` |
| **Omron TIME_OF_DAY** | `0x0B` | reads as `BigInt` nanoseconds; write `BigInt` (or `number`) nanoseconds |
| **Omron UNION** | `0x0C` | `Buffer` |
| **Omron BCD** (UINT/UDINT/ULINT) | `0x04`-`0x06` | `Buffer` |

Notes:

- **64-bit integers** (LINT, ULINT) are `BigInt` because they can exceed JavaScript's safe
  integer limit (2^53-1). Reads return `BigInt`; writes accept `BigInt` or `number`.
- **REAL** is single precision, so values round (writing `3.14` reads back ~`3.1400001`).
  Compare floats with a tolerance.
- The **Omron-specific types** (`0x04`-`0x0C`) are NX/NJ extensions beyond the standard CIP
  set; they are decoded automatically. The DATE/TIME family carries nanosecond values.
- **Date/time types (DATE, DATE_AND_TIME, TIME, TIME_OF_DAY) — verified on hardware (NX102).**
  Reads return a JS `Date` (DATE / DATE_AND_TIME) or a `BigInt` of nanoseconds (TIME /
  TIME_OF_DAY). For writes: DATE / DATE_AND_TIME use nanoseconds since the 1970 epoch (a `Date`
  is the easiest input; epoch&nbsp;ms&nbsp;×&nbsp;1,000,000 also works), and TIME / TIME_OF_DAY
  are a nanosecond duration. Verified accurate to **millisecond** precision. Because the
  underlying value is a 64-bit nanosecond integer (a ~19-digit number), sub-millisecond digits
  can be silently rounded off if you pass a plain `Number` — pass a **`BigInt`** (e.g.
  `5000000000n`) when you need full nanosecond precision.
- Type validation happens **before** anything goes on the wire — writing the wrong type or an
  out-of-range value throws a clear `TypeError`/`RangeError` (e.g. `300` to a BYTE).

---

## Structures, arrays, and nested addressing

The same `readVariable` / `writeVariable` calls handle any level of nesting — you just name
what you want, exactly as it's named in the controller:

| Goal | Name |
|---|---|
| whole array | `MyArray` |
| one array element | `MyArray[3]` |
| whole structure | `MyStruct` |
| a structure member | `MyStruct.Speed` |
| element of an array inside a struct | `MyStruct.History[2]` |
| member of a struct inside an array | `Machine.Axes[2].Position` |
| arbitrarily deep | `Cell.Stations[1].Tools[3].Offset` |

```js
// Whole structure -> JS object
const recipe = await plc.readVariable('CurrentRecipe');
// { Name: 'BATCH_07', Speed: 1500, Steps: [10, 20, 30] }

// Whole array -> JS array
const profile = await plc.readVariable('TempProfile');   // [21.0, 21.5, 22.1, ...]

// Write a whole structure back
await plc.writeVariable('CurrentRecipe', { Name: 'BATCH_08', Speed: 1600, Steps: [10, 20, 40] });

// Or just one member (safer - doesn't overwrite the rest)
await plc.writeVariable('CurrentRecipe.Speed', 1600);
```

Reading or writing a **whole** array or structure in one call is the fastest way to move a lot
of data — it's a single request (chunked internally if large), versus many element-by-element
round-trips. The library manages the structure's CRC handle automatically.

---

## Bulk reads and writes

For many tags, `readVariables` / `writeVariables` are far more efficient than looping. They use
the CIP Multiple Service Packet where it fits and fall back to concurrent individual requests
otherwise:

```js
const values = await plc.readVariables(['A', 'B', 'C'], { mode: 'auto' });
// -> { A: ..., B: ..., C: ... }

await plc.writeVariables({ Setpoint: 1500, Mode: 3, Enable: true });
```

Use `{ partial: true }` on a bulk read to get per-tag failures returned inline instead of the
whole call rejecting. (`writeVariables` is not an atomic group write — for atomicity, write a
structure.)

---

## Verified writes

A normal write returns once the controller accepts it. A **verified write** additionally reads
the value back and confirms it matches — useful for critical setpoints:

```js
await plc.verifiedWriteVariable('Setpoint', 1500);   // throws if read-back differs
```

It costs one extra round-trip. Floats are compared with tolerance.

---

## Monitoring tags for changes

`MonitoredVariable` polls a tag on an interval and emits a `change` event when the value
changes, so you can react instead of polling by hand:

```js
const { MonitoredVariable } = require('omron-eip');

const monitor = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 100 });
monitor.on('change', (newValue, oldValue) => {
  console.log('Counter changed:', oldValue, '->', newValue);
});

// It also supports async iteration:
for await (const value of monitor) {
  console.log('latest:', value);
}
```

Pass it an `NSeriesController` (below) so monitoring survives reconnects.

---

## Connection handling, disconnects, and reconnects

There are two clients:

**`NSeries`** — the basic client. One connection, no automatic recovery. If the socket drops,
the next call fails and it's up to you to reconnect. Good for scripts and short tasks. Always
`close()` it when done to release the socket cleanly.

**`NSeriesController`** — the resilient client for long-running use. It wraps `NSeries` and
adds:

- **Automatic reconnection** on socket errors, using exponential backoff with full jitter
  (configurable base/ceiling), so a flapping link doesn't hammer the controller.
- **Optional keep-alive** — a periodic lightweight request that detects a silently dead
  connection.
- **Operation serialization** — all reads/writes go through an internal queue, so many callers
  can share one controller without their requests racing or corrupting the connection.
- **Events** you can subscribe to: `connect`, `disconnect`, `reconnect`, `error`,
  `dispatcherError`.

```js
const { NSeriesController } = require('omron-eip');

const plc = new NSeriesController({
  host: '192.168.250.1',
  keepAlive: true,                // detect dead links
  keepAliveIntervalMs: 5000,
  reconnectDelayMs: 1000,         // backoff base (attempt 1's max delay)
  reconnectMaxDelayMs: 30000,     // backoff ceiling
  reconnectBackoffJitter: true,   // exponential backoff w/ full jitter
  maxReconnectAttempts: Infinity, // set to 0 to disable auto-reconnect
  autoConnect: false,             // connect immediately on construction
});

plc.on('connect',    ()  => console.log('connected'));
plc.on('disconnect', ()  => console.log('disconnected'));
plc.on('reconnect',  (n) => console.log('reconnected after', n, 'attempts'));
plc.on('error',      (e) => console.error('controller error:', e.message));

await plc.connect();
// ... use plc.readVariable / writeVariable / etc. exactly like NSeries ...
await plc.close();   // stops keep-alive + reconnection and closes the socket
```

**Clean shutdown.** Call `close()` to stop the keep-alive timer, cancel any pending
reconnection, drain the operation queue, and close the TCP socket. After `close()`, the
controller will not attempt to reconnect. On the basic `NSeries`, `close()` simply closes the
socket. Either way, calling `close()` is how you guarantee the process can exit cleanly.

---

## Variable discovery

You can read/write any published tag without discovery — the library learns each tag's type on
first access. When you want the full list (for a UI, validation, or to warm the type cache):

```js
const { skipped } = await plc.updateVariableDictionary();
plc.userVariableList();     // user-defined tags
plc.systemVariableList();   // Omron system tags (names start with _)
plc.variableList();         // both

console.log(plc.skippedVariables);  // any tags whose type couldn't be resolved (rare)
```

Discovery is **expensive** (one request per tag plus derived-type lookups — tens of seconds for
hundreds of tags), so call it once at startup, or persist it:

```js
await plc.updateVariableDictionary();
await plc.saveCurrentDictionary('dict.json');
// next run:
await plc.loadDictionaryFileIfPresent('dict.json');  // loads if present, else discovers + saves
```

`updateVariableDictionary()` is resilient: a variable whose type can't be resolved is skipped
(recorded in `plc.skippedVariables`) rather than aborting the whole scan. Pass
`{ skipUnknown: false }` to make it strict.

---

## Device discovery

Find controllers on a subnet by UDP broadcast, without knowing their IPs:

```js
const { discoverDevices } = require('omron-eip');
const devices = await discoverDevices({ broadcastAddress: '192.168.1.255' });
// each device reports vendor, product, serial, name, etc.
```

---

## Error handling

Two distinct kinds of error:

- **Validation errors** (`TypeError` / `RangeError`) — thrown *before* anything is sent, when a
  value doesn't fit the tag (wrong type, out of range).
- **`CIPException`** — returned by the controller with a CIP status code. Common ones: `0x05`
  (variable not found / not published), `0x13` / `0x15` (data too short / too long, or type
  mismatch), `0x11` (reply too large — relevant to Class 3 large arrays).

```js
const { CIPException } = require('omron-eip');
try {
  await plc.writeVariable('Setpoint', 1500);
} catch (err) {
  if (err instanceof CIPException) {
    console.error('CIP status 0x' + err.status.toString(16), err.message);
  } else {
    console.error('validation/other:', err.message);
  }
}
```

For bulk reads, `{ partial: true }` keeps one bad tag from failing the whole batch.

---

## Full API summary

**Clients**

- `new NSeries({ host, useConnectedMessaging?, ... })` — basic client.
- `new NSeriesController({ host, keepAlive?, reconnect*?, ... })` — resilient client (same
  read/write API plus events and auto-reconnect).
- `new MonitoredVariable(client, name, { refreshTimeMs })` — change-event poller.

**Read / write (both clients)**

- `connect()`, `close()`
- `readVariable(name)`, `writeVariable(name, value)`
- `verifiedWriteVariable(name, value)`
- `readVariables(names, opts?)`, `writeVariables(map, opts?)`
- `usingConnectedMessaging()`, `connectedMessagingError`

**Dictionary**

- `updateVariableDictionary(opts?)` -> `{ skipped }`; `skippedVariables`
- `variableList()`, `userVariableList()`, `systemVariableList()`
- `saveCurrentDictionary(file)`, `loadDictionaryFile(file)`, `loadDictionaryFileIfPresent(file)`

**Controller events**

- `connect`, `disconnect`, `reconnect`, `error`, `dispatcherError`

**Discovery**

- `discoverDevices({ broadcastAddress })`

**Low-level** (advanced) — the `cip` and `eip` namespaces, the `CIP*`/`Omron*` data-type
classes, `createTypeInstance`, `CIPException`, and the type registry are all exported for
building custom requests. See the docs below.

---

## More documentation

This package ships several guides:

- **MANUAL.md** — narrative, feature-by-feature guide to using the library.
- **EXAMPLES.md** — runnable code for every feature, plus a complete API reference.
- **CHANGELOG.md** — what changed between versions.

The project also maintains (in the source repository) ARCHITECTURE, PROTOCOL,
NX102_PERFORMANCE, INSTALL, and TESTING documents for contributors and protocol implementers.

---

Port of `aphyt` library

## License

GPLv2, the same license as the original `aphyt` library this is ported from. See the
[LICENSE](./LICENSE) file for the full text.
