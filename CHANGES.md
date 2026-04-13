# Changes to signalk-to-influxdb2

Two new optional features plus a build fix. Both features are fully backwards-compatible
— existing configs with no `tagPaths` or `consolidatedMeasurement` behave identically
to the original.

---

## Build fix: `skipLibCheck` in `tsconfig.json`

`npm run build` failed with type errors in
`node_modules/@signalk/server-api/dist/streambundle.d.ts`:

```
error TS2314: Generic type 'Bus<E, A>' requires 2 type argument(s)
```

This is a version mismatch between `@types/baconjs` (which defines `Bus<E, A>` with
2 type parameters) and `@signalk/server-api`'s type declarations (written against an
older version with 1 type parameter). It is a pre-existing upstream dependency issue,
not caused by our changes.

Fix: add `"skipLibCheck": true` to `tsconfig.json`. This tells the TypeScript compiler
to skip type checking of `.d.ts` files in `node_modules`. This is standard practice
for this class of problem and is already used by most SignalK plugins.

---

## Feature 1: Tag paths (`tagPaths`)

Promotes a SK path's current value to an InfluxDB **tag** on every point written.
Designed for slowly-changing state (motor on/off, etc.) that you want to use as a
filter dimension in queries without a join.

### Config example

```json
{
  "tagPaths": [
    {
      "path": "sails.inventory.main.active",
      "tagName": "sail_config",
      "defaultValue": "unknown"
    }
  ]
}
```

Note: paths are the short SK form (without `vessels.self.` prefix), matching the path
field in delta messages.

### How it works

- `SKInflux` maintains a `tagCache: Map<path → { tagName, value }>`.
- On every `handleValue` call, if the path is in `tagPaths`, the cache is updated.
- `applyTagCache()` applies all cached tag values to every `Point` before it is written.
- The path's value is still written as a normal data point (cache update does not
  suppress the write).
- Until the first update arrives for a tagPath, no tag is written (unless
  `defaultValue` is set).

### Files changed

- `src/influx.ts` — `TagPathConfig` interface, `tagPathsConfig`/`tagCache` fields,
  constructor init, `applyTagCache()` method, `handleValue()` cache update,
  `toPoints()` calls `applyTagCache()` on all returned points.
- `src/PluginConfigSchema.ts` — `tagPaths` array added to per-influx config schema.

---

## Feature 2: Consolidated measurement (`consolidatedMeasurement`)

Writes all SK path values to a **single named measurement**, using the SK path as
the field name rather than the measurement name. Makes analytics queries dramatically
simpler — no pivot/join needed.

### Config example

```json
{
  "consolidatedMeasurement": "instruments"
}
```

### Resulting InfluxDB schema

```
measurement: instruments
  tags:   context, source, self, sail_config (if tagPaths configured)
  fields: navigation.speedThroughWater = 3.2
          environment.wind.speedTrue   = 5.3
          environment.wind.angleTrueWater = -0.785
          navigation.position.lat = 50.123   (field name: "lat")
          navigation.position.lon = -1.456   (field name: "lon")
          navigation.attitude.pitch = 0.02
          navigation.attitude.roll  = 0.05
          navigation.attitude.yaw   = 1.23
          vessels.self.sails.active = "main+jib"
          ...
```

### Behaviour differences from original

| Situation | Original | Consolidated |
|-----------|----------|--------------|
| Field name | always `value` | SK path (e.g. `navigation.speedThroughWater`) |
| Measurement name | SK path | configured name (e.g. `instruments`) |
| `navigation.attitude` | 3 separate measurements | 3 fields on 1 point |
| Object values (notifications, JSON) | written as stringified JSON | **skipped** |

These modes are **mutually exclusive**: when `consolidatedMeasurement` is set, per-path
measurements are NOT written — only the consolidated measurement is written. This keeps
storage at the same size as per-path mode (no doubling). To run both modes simultaneously,
add a second entry in the `influxes` array pointing at the same InfluxDB server.

Object values are skipped in consolidated mode because writing JSON strings to an
analytics measurement would pollute field types. Use `filteringRules` to allow only
the paths you want if you need strict control over what goes into the measurement.

### Files changed

- `src/influx.ts` — `consolidatedMeasurement` field, constructor init, `toPoints()`
  uses `measurementName` variable, `navigation.attitude` consolidated path, field name
  logic, object skip.
- `src/PluginConfigSchema.ts` — `consolidatedMeasurement` string added to per-influx
  config schema.

---

## Feature 1b: Sail inventory tag (`sailInventoryTag`)

Builds a canonical `sail_config` tag by watching all `sails.inventory.*.active`
boolean paths — the standard SignalK paths written by sail management apps via the
delta stream.

Active sail names are collected into a `Set`, then sorted alphabetically and joined
with `+` on every update. This guarantees a stable tag value regardless of the order
updates arrive (`"jib+main"` always, never `"main+jib"`).

### Config example

```json
{
  "sailInventoryTag": {
    "tagName": "sail_config",
    "defaultValue": "unknown"
  }
}
```

This is mutually exclusive with using `tagPaths` for sail configuration. Use
`sailInventoryTag` in preference to `tagPaths` for sails — it is correct against the
SK spec and produces canonical, order-stable tag values.

---

## Recommended plugin config for polar generation

```json
{
  "url": "http://127.0.0.1:8086",
  "token": "",
  "org": "your-org",
  "bucket": "sailing",
  "onlySelf": true,
  "resolution": 1000,
  "consolidatedMeasurement": "instruments",
  "sailInventoryTag": {
    "tagName": "sail_config",
    "defaultValue": "unknown"
  }
}
```

With `resolution: 1000` the plugin writes at most once per second per path — matching
the NMEA2000 instrument update rate and keeping storage manageable.

## Flux query for polar data

```flux
from(bucket: "sailing")
  |> range(start: 2025-01-01T00:00:00Z, stop: now())
  |> filter(fn: (r) => r._measurement == "instruments")
  |> filter(fn: (r) => r.self == "true")
  |> filter(fn: (r) => r.sail_config == "jib+main")
  |> filter(fn: (r) =>
      r._field == "navigation.speedThroughWater" or
      r._field == "environment.wind.speedTrue" or
      r._field == "environment.wind.angleTrueWater" or
      r._field == "navigation.speedOverGround" or
      r._field == "navigation.courseOverGroundTrue" or
      r._field == "navigation.headingTrue" or
      r._field == "lat" or
      r._field == "lon"
  )
  |> pivot(rowKey: ["_time", "sail_config"], columnKey: ["_field"], valueColumn: "_value")
```

This returns a table where each row is a timestamp with all instrument values as
columns — exactly what the polar generator needs.
