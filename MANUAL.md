# omron-eip — Library Manual

A guided, feature-by-feature manual for using the **omron-eip** Node.js library to communicate
with Omron NX/NJ controllers over EtherNet/IP. This manual explains *what* each feature is,
*when* to use it, and *how* it fits together. For copy-paste runnable code on every topic, see
**[EXAMPLES.md](./EXAMPLES.md)** — this manual references the relevant example section as it
goes.

> **Quick orientation of the docs**
> - **This manual** — narrative "how to use it", concepts and guidance.
> - **[EXAMPLES.md](./EXAMPLES.md)** — runnable code for every feature (18 sections + full API reference).
> - **[README.md](./README.md)** — short overview + quick start.
> - **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the code is organized internally.
> - **[PROTOCOL.md](./PROTOCOL.md)** — the wire protocol, if you're reimplementing it elsewhere.
> - **[NX102_PERFORMANCE.md](./NX102_PERFORMANCE.md)** — measured speeds and polling limits.
> - **[TESTING.md](./TESTING.md)** / **[INSTALL.md](./INSTALL.md)** — running tests / installing.

---

## Contents

1. [Installation and a first connection](#1-installation-and-a-first-connection)
2. [Choosing a client class](#2-choosing-a-client-class)
3. [Reading tags](#3-reading-tags)
4. [Writing tags](#4-writing-tags)
5. [Data types — what you get back, what to send](#5-data-types-what-you-get-back-what-to-send)
6. [Structures, arrays, and nested addressing](#6-structures-arrays-and-nested-addressing)
7. [Bulk reads and writes](#7-bulk-reads-and-writes)
8. [Verified writes](#8-verified-writes)
9. [Monitoring tags for changes](#9-monitoring-tags-for-changes)
10. [The resilient client: reconnect and keep-alive](#10-the-resilient-client-reconnect-and-keep-alive)
11. [Variable discovery and the dictionary](#11-variable-discovery-and-the-dictionary)
12. [Saving and loading the dictionary](#12-saving-and-loading-the-dictionary)
13. [Class 3 connected messaging](#13-class-3-connected-messaging)
14. [Device discovery](#14-device-discovery)
15. [Error handling](#15-error-handling)
16. [TypeScript](#16-typescript)
17. [Other Omron devices](#17-other-omron-devices)
18. [Performance and best practices](#18-performance-and-best-practices)
19. [Troubleshooting](#19-troubleshooting)

---

## 1. Installation and a first connection

The library has zero runtime dependencies and works on Node 16+. Install it (or, if it's not
published, install from the local folder — see [INSTALL.md](./INSTALL.md)), then:

```js
const { NSeries } = require('omron-eip');

const plc = new NSeries({ host: '192.168.250.1' });
await plc.connect();
const value = await plc.readVariable('Counter');
console.log(value);
await plc.close();
```

That's the whole shape of it: construct, `connect()`, do reads/writes, `close()`. Everything
else in this manual builds on that.

Runnable version: EXAMPLES.md has this throughout, starting at section 2.

---

## 2. Choosing a client class

The library gives you three classes. Picking the right one is the first decision.

- **`NSeries`** — the basic client. One connection, no automatic reconnection. Best for
  scripts, tests, and short-lived tasks where you control the lifecycle.
- **`NSeriesController`** — the resilient client. Wraps `NSeries` and adds automatic
  reconnection (exponential backoff + jitter), optional keep-alive, and an event interface. It
  serializes operations internally so many callers can share it safely. **Use this for
  anything long-running or production.**
- **`MonitoredVariable`** — not a connection; a helper that polls one tag through a client and
  emits events when the value changes.

A common production pattern is one `NSeriesController` per controller, shared by all the code
that talks to it, plus `MonitoredVariable` instances for the tags you want to react to.

See EXAMPLES.md section 1 for a side-by-side, and sections 10–11 for the controller.

---

## 3. Reading tags

`readVariable(name)` returns the tag's value as a native JS value — you don't declare the
type, the library determines it:

```js
const speed = await plc.readVariable('Machine.Speed');
```

The name is a **symbolic name** exactly as defined on the controller, and it can address far
more than a flat scalar — see [section 6](#6-structures-arrays-and-nested-addressing).

To read several tags efficiently in one shot, use bulk reads ([section 7](#7-bulk-reads-and-writes))
rather than awaiting many single reads.

Runnable: EXAMPLES.md section 2 (every type), section 4 (structures), section 5 (arrays).

---

## 4. Writing tags

`writeVariable(name, value)` sends a native JS value; the library packs the bytes for the
tag's actual type:

```js
await plc.writeVariable('Machine.Speed', 1500);
await plc.writeVariable('Machine.Enable', true);
```

If you need certainty that the write took effect, use a [verified write](#8-verified-writes).
To change one field of a structure, write the member directly (`Machine.Config.Speed`) rather
than rewriting the whole structure — it's safer (no read-modify-write race) and smaller.

Runnable: EXAMPLES.md section 3 (every type), section 6 (verified writes).

---

## 5. Data types — what you get back, what to send

The library maps Omron/CIP types to JS types automatically. The essentials:

- **Integers** (SINT, INT, DINT, USINT, UINT, UDINT, BYTE/WORD/DWORD as values) → JS `number`.
- **64-bit integers** (LINT, ULINT, LWORD) → JS `BigInt`, because they can exceed JavaScript's
  safe integer range (2^53−1). You can write them as `BigInt` or `number`; reads return
  `BigInt`. Convert with `Number(v)` when you know it fits.
- **Floats** (REAL, LREAL) → JS `number`. Remember single-precision REAL rounds (writing 3.14
  reads back ~3.1400001) — compare with tolerance.
- **BOOL** → JS `boolean`.
- **STRING** → JS `string` (up to the tag's configured max; on this controller, 1986 chars).
- **Structures** → plain JS objects; **arrays** → JS arrays (see [section 6](#6-structures-arrays-and-nested-addressing)).
- **Omron-specific types** (added in 0.2.4): **ENUM** → `number` (the enum value);
  **DATE** / **DATE_AND_TIME** → JS `Date`; **TIME** / **TIME_OF_DAY** → `BigInt` nanoseconds;
  **UNION** and **BCD** → `Buffer`.

A full code-level type tour is in EXAMPLES.md sections 2 (read) and 3 (write); the type→code
table is in [README.md](./README.md#cip-type-mapping).

---

## 6. Structures, arrays, and nested addressing

This is where symbolic addressing shines. The same `readVariable`/`writeVariable` calls handle
every level of nesting — you just name what you want:

| Goal | Name |
|---|---|
| whole array | `MyArray` |
| one element | `MyArray[3]` |
| whole structure | `MyStruct` |
| a member | `MyStruct.Speed` |
| element of an array inside a struct | `MyStruct.History[2]` |
| member of a struct inside an array | `Machine.Axes[2].Position` |
| arbitrarily deep | `Cell.Stations[1].Tools[3].Offset` |

Reading a whole structure returns a nested JS object; reading a whole array returns a JS array.
Writing them takes the same shapes. Reading/writing a **whole** array or structure in one call
is the fastest way to move bulk data (one request, chunked internally if large).

For structure writes the library manages the structure's CRC handle for you (it's captured on
first read of that type). Writing a single **member** doesn't need the CRC and avoids
overwriting other members — prefer member writes unless you mean to set the whole structure.

Runnable: EXAMPLES.md section 4 (structures) and section 5 (arrays, including multi-dimensional).

---

## 7. Bulk reads and writes

When you need many tags, `readVariables` / `writeVariables` do it in far fewer round-trips than
looping single calls. The library automatically uses the CIP Multiple Service Packet (MSP) and
falls back to concurrent individual requests where MSP doesn't fit (e.g. large structures):

```js
const values = await plc.readVariables(['A', 'B', 'C'], { mode: 'auto' });
// -> { A: ..., B: ..., C: ... }

await plc.writeVariables({ Setpoint: 1500, Mode: 3 });
```

Use `{ partial: true }` on reads if you want per-tag failures returned inline rather than the
whole call rejecting. Don't reach for bulk on a single tag (plain `readVariable` is leaner), and
note `writeVariables` is not an atomic group write — if you need atomicity, write a structure.

Runnable: EXAMPLES.md section 7 (with the "when NOT to use bulk" guidance).

---

## 8. Verified writes

A normal write returns once the controller accepts it. A **verified write** additionally reads
the value back and confirms it matches — useful for critical setpoints:

```js
await plc.verifiedWriteVariable('Setpoint', 1500);   // throws if read-back differs
```

It costs an extra round-trip. For floats it compares with tolerance (because of REAL rounding).

Runnable: EXAMPLES.md section 6.

---

## 9. Monitoring tags for changes

`MonitoredVariable` polls a tag on an interval and emits `change` events, so you react to value
changes instead of polling manually:

```js
const { MonitoredVariable } = require('omron-eip');
const monitor = new MonitoredVariable(plc, 'Counter', { refreshTimeMs: 100 });
monitor.on('change', (newValue, oldValue) => { /* ... */ });
```

It also supports `for await (...)` async iteration. You pass it a client (usually an
`NSeriesController`, so polling survives reconnects).

Runnable: EXAMPLES.md section 10.

---

## 10. The resilient client: reconnect and keep-alive

`NSeriesController` is what you should use for anything that runs for a while. It:

- reconnects automatically with exponential backoff + jitter after a drop,
- can send a periodic keep-alive so a silently dead link is detected,
- serializes all operations on an internal queue, so concurrent callers are safe on one
  connection,
- emits events: `connect`, `disconnect`, `reconnect`, `error`, `dispatcherError`.

```js
const { NSeriesController } = require('omron-eip');
const plc = new NSeriesController({ host: '192.168.250.1', keepAlive: true });
plc.on('reconnect', n => console.log('reconnected after', n, 'attempts'));
await plc.connect();
```

It exposes the same read/write/bulk/dictionary methods as `NSeries`, so everything else in this
manual applies unchanged.

Runnable: EXAMPLES.md section 11.

---

## 11. Variable discovery and the dictionary

You can read or write any published tag without discovery — the library learns each tag's type
on first access. When you want the full list (for a UI, validation, or to warm the type cache),
call `updateVariableDictionary()`:

```js
const { skipped } = await plc.updateVariableDictionary();
plc.userVariableList();    // user tags
plc.systemVariableList();  // Omron system tags (start with _)
```

It's expensive (one request per tag plus derived-type lookups — tens of seconds for hundreds of
tags), so typically you call it once at startup, or persist it ([section 12](#12-saving-and-loading-the-dictionary)).

Since 0.2.4 it's **resilient to unknown types**: a variable whose type can't be resolved is
skipped (returned in `skipped` and stored on `plc.skippedVariables`) rather than aborting the
scan. Pass `{ skipUnknown: false }` to restore strict behavior.

Runnable: EXAMPLES.md section 8.

---

## 12. Saving and loading the dictionary

To avoid the discovery cost on every startup, persist the dictionary and reload it:

```js
await plc.updateVariableDictionary();
await plc.saveCurrentDictionary('dict.json');
// next run:
await plc.loadDictionaryFileIfPresent('dict.json');   // loads if present, else discovers + saves
```

Runnable: EXAMPLES.md section 9.

---

## 13. Class 3 connected messaging

By default the library uses UCMM (unconnected) messaging, which is the validated, fastest path
for a direct connection. You can opt into CIP **Class 3 connected** messaging:

```js
const plc = new NSeries({ host: '192.168.250.1', useConnectedMessaging: true });
await plc.connect();
if (plc.usingConnectedMessaging()) { /* Class 3 active */ }
else { /* fell back to UCMM */ console.log(plc.connectedMessagingError); }
```

The library auto-negotiates the Forward_Open variant (Omron needs the classic 0x54, not the
Large 0x5B) and silently falls back to UCMM if the controller declines — so enabling it never
breaks anything. **On a direct connection, UCMM is faster** (Class 3 serializes on one
connection and can't read very large arrays); Class 3 mainly helps through routing gateways.
Most users should leave it off.

Runnable: EXAMPLES.md section 12. Background and measurements: NX102_PERFORMANCE.md.

---

## 14. Device discovery

To find controllers on a subnet without knowing their IPs, broadcast a discovery request:

```js
const { discoverDevices } = require('omron-eip');
const devices = await discoverDevices({ broadcastAddress: '192.168.1.255' });
```

Each reachable device replies with identity info (vendor, product, serial, name).

Runnable: EXAMPLES.md section 13.

---

## 15. Error handling

Two distinct kinds of error:

- **Validation errors** — thrown *before* anything goes on the wire when a value doesn't fit
  the tag (wrong type, out of range). These are plain `TypeError`/`RangeError`, e.g. writing a
  string to a DINT, or 300 to a BYTE.
- **`CIPException`** — returned by the controller, carrying a CIP status code. Common ones:
  `0x05` (variable not found / not published), `0x13`/`0x15` (data too short/long or type
  mismatch), `0x11` (reply too large — relevant to Class 3 large arrays).

Wrap calls in try/catch and inspect the error. For bulk reads, `{ partial: true }` keeps
per-tag failures from failing the whole batch.

Runnable: EXAMPLES.md section 16. Status-code list: [README.md](./README.md#status-codes).

---

## 16. TypeScript

The package ships `.d.ts` declarations covering every class, method, option, and event,
compiled under `--strict`. Import types directly:

```ts
import { NSeriesController, BulkResult } from 'omron-eip';
```

Runnable: EXAMPLES.md section 14.

---

## 17. Other Omron devices

Beyond NX/NJ controllers, the library includes wrappers ported for the F4 vision system,
K6PM-TH thermal monitor, V4 barcode reader, and the generic TCP Interface Object. **These are
ported but untested against real hardware** — treat them as a starting point and verify.

Runnable: EXAMPLES.md section 15.

---

## 18. Performance and best practices

- **Batch your reads.** One `readVariables([...])` beats many `readVariable` calls.
- **Move bulk data as whole arrays/structures**, not element-by-element (~30,000 elements/sec
  as a single array read on a direct NX102).
- **Prefer member writes** over whole-structure writes unless you mean to set everything.
- **Use `NSeriesController`** for anything long-running; share one per controller.
- **Pick poll rates with headroom** — see NX102_PERFORMANCE.md for measured limits (e.g. ~50
  tags @ 100 ms, ~100 @ 250 ms, ~200 @ 500 ms on a direct connection). Put fast- and
  slow-changing data on separate intervals.
- **Keep UCMM** unless you specifically route through a gateway.
- **Match data types** and respect ranges; the library rejects mismatches with clear errors.

Full numbers and methodology: NX102_PERFORMANCE.md.

---

## 19. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `CIPException` status `0x05` | Tag name wrong, or not published. In Sysmac Studio set Network Publish = Publish Only and transfer the project. |
| `TypeError`/`RangeError` on write | Value doesn't fit the tag (wrong type, out of range). Send the right JS type within range. |
| Write of `3.14` reads back `3.1400001` | Expected single-precision REAL rounding; compare floats with tolerance. |
| `updateVariableDictionary` reports skipped vars | A type the library couldn't resolve was skipped; inspect `plc.skippedVariables`. Most types are supported as of 0.2.4. |
| Class 3 won't open / large array read fails on Class 3 | Use UCMM (the default); see [section 13](#13-class-3-connected-messaging). |
| Connection keeps dropping | Use `NSeriesController` for auto-reconnect; check the physical link and that the host/route can reach the PLC. |
| 64-bit value looks wrong | LINT/ULINT/LWORD are `BigInt`; don't coerce through `Number` if the value exceeds 2^53−1. |

For anything protocol-level (byte layouts, Forward_Open, CIP framing), see PROTOCOL.md.
