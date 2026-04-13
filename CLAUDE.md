# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript compilation → dist/
npm run test           # Start Docker InfluxDB, build, then run tests
npm run mocha          # Run tests only (requires InfluxDB already running)
npm run format         # Prettier + ESLint fix
npm run lint:only      # ESLint without auto-fix
```

To run a single test file or filter tests:
```bash
npx mocha --require ts-node/register src/plugin.test.ts --grep "filtering"
```

Tests require Docker running. InfluxDB starts via `docker-compose.yml` on port 8086 with org `signalk_org`, bucket `signalk_bucket`, token `signalk_token`.

## Architecture

This is a **Signal K Server plugin** that writes navigation telemetry from a Signal K server into InfluxDB v2 for time-series storage.

### Data Flow

```
Signal K delta (path + value + context)
    ↓
plugin.ts — onDelta handler, one SKInflux instance per configured InfluxDB server
    ↓
influx.ts (SKInflux class)
    ├─ Resolution check (throttle writes per path)
    ├─ Tag cache update (if path is a configured tagPath)
    ├─ Filtering rules (allow/deny by path or source regex)
    ├─ toPoints() — convert SK value → InfluxDB Point(s)
    │   ├─ Normal mode: measurement = SK path
    │   └─ Consolidated mode: measurement = configuredName, field = SK path
    ├─ Apply cached tags to each point
    └─ Batch write to InfluxDB
    ↓
HistoryAPI.ts — HTTP query interface implementing SK History API
    ├─ /values, /paths, /contexts endpoints
    ├─ Aggregation: mean, min, max, sma, ema
    └─ GPX export for position tracks
```

### Key Source Files

- **`src/plugin.ts`** — Plugin factory (`InfluxPluginFactory`). Registers the plugin with Signal K, wires up delta handling, instantiates `SKInflux` per configured server, and registers the `InfluxHistoryProvider`. Also handles optional daily log distance calculation.

- **`src/influx.ts`** — `SKInflux` class. All InfluxDB write logic: filtering rules, resolution/throttling, tag path cache, consolidated vs. split measurement naming, special handling for `navigation.attitude` (splits into pitch/roll/yaw fields), S2 geo-cell tagging for positions, and batched writes.

- **`src/HistoryAPI.ts`** — `InfluxHistoryProvider` class. Implements the Signal K History API over Flux queries. Handles aggregation, time ranges, context filtering, and GPX track export.

- **`src/PluginConfigSchema.ts`** — JSON Schema definition for the Signal K admin UI configuration form.

### Configuration Concepts

Each InfluxDB destination can be configured with:
- **Filtering rules** — ordered allow/deny rules matching path and source by regex
- **Resolution** — minimum interval between writes for the same path (throttling)
- **tagPaths** — SK paths whose current values are attached as InfluxDB tags on all subsequent points (e.g., sail configuration state)
- **consolidatedMeasurement** — write all paths to one InfluxDB measurement with path as field name, instead of one measurement per path
- **onlySelf** — only record data for the `vessels.self` context

### TypeScript / Build Notes

- Output goes to `dist/` (CommonJS, ES2022 target). Entry point is `index.js` → `dist/plugin.js`.
- Strict TypeScript. External types come from `@signalk/server-api` and `@chacal/signalk-ts`.
- Date/time uses `@js-joda/core` (not native Date) throughout HistoryAPI.
