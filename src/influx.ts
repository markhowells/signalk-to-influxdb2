/*
 * Copyright 2022 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Context, Path, PathValue, SourceRef, Timestamp } from '@signalk/server-api'
import { HttpError, InfluxDB, Point, QueryApi, WriteApi, WriteOptions } from '@influxdata/influxdb-client'
import { BucketsAPI, DbrpsAPI, OrgsAPI } from '@influxdata/influxdb-client-apis'
import { InfluxDB as InfluxV1 } from 'influx'
import { getUnits } from '@signalk/signalk-schema'

import { Logging, QueryParams } from './plugin'
import { S2 } from 's2-geometry'

export const SELF_TAG_NAME = 'self'
export const SELF_TAG_VALUE = 'true'

interface FilteringRule {
  /**
   * @title Allow rule
   * @description Check to use this rule for picking data for writing, otherwise this rule will cause data to be ignored.
   */
  allow: boolean
  /**
   * @title Path
   * @description Literal value or JS regular expression.
   */
  path: string

  /**
   * @title Source
   * @description Literal value or JS regular expression. You can copypaste values from server's Data Browser
   */
  source: string
}

/**
 * Configuration for promoting a SK path's value to an InfluxDB tag.
 * The path's value is cached and applied as a tag on every point written.
 */
interface TagPathConfig {
  /**
   * @title SK path
   * @description The SignalK path whose current value should be used as a tag (e.g. sails.inventory.main.active)
   */
  path: string
  /**
   * @title Tag name
   * @description The InfluxDB tag name to write (e.g. sail_config)
   */
  tagName: string
  /**
   * @title Default value
   * @description Value to use before the path receives its first update. If omitted, no tag is written until the first update arrives.
   */
  defaultValue?: string
}

/**
 * Configuration for building a canonical sail_config tag from sails.inventory.*.active booleans.
 * Active sail names are sorted alphabetically and joined with '+' to produce a stable tag value
 * regardless of the order in which updates arrive (e.g. "jib+main" rather than "main+jib").
 */
interface SailInventoryTagConfig {
  /**
   * @title Enabled
   * @description Enable or disable sail inventory tag derivation.
   * @default true
   */
  enabled: boolean
  /**
   * @title Tag name
   * @description The InfluxDB tag name to write (e.g. sail_config)
   */
  tagName: string
  /**
   * @title Default value
   * @description Value to use before any sails.inventory.*.active updates arrive.
   */
  defaultValue?: string
}

export interface SKInfluxConfig {
  /**
   * Url of the InfluxDb 2 server
   * @default http://127.0.0.1:8086
   * @title Url
   * @description InfluxDB server address in http://hostname:port format
   */
  url: string
  /**
   * Authentication token
   *
   * @title Token
   */
  token: string
  /**
   * @title Organisation
   */
  org: string
  /**
   * @title Bucket
   */
  bucket: string

  /**
   * @title Store only self data
   * @default true
   * @description Store data only for "self" vessel, not for example AIS targets' data
   */
  onlySelf: boolean

  /**
   * @title Filtering Rules
   * @default []
   * @description Filtering rules for allowing and/or ignoring data for writing. First matching rule decides whether to allow writing or ignore and not write the value. If there are rules but none of them match the value will be written. Adding rules disables ignoredPaths and ignoredValues. To pick some values add allow rules for them and an "ignore all" rule at the end with .* in either path or source field. Activate Debug logging in plugin configuration to get logging on server startup about ignored and allowed data.
   */
  filteringRules: FilteringRule[]

  /**
   * @title Ignored paths
   * @default []
   * @description Paths that should be ignored and not written to InfluxDB (JS regular expressions work)
   */
  ignoredPaths: string[]

  /**
   * @title Ignored sources
   * @default []
   * @description Sources whose data should be ignored and not written to InfluxDB (JS regular expressions work)
   */
  ignoredSources: string[]

  /**
   * @title Use timestamps from SK data
   * @default false
   * @description Whether the timestamps in SK data should be used instead of time of insertion to InfluxDB
   */
  useSKTimestamp: boolean

  /**
   * @title Resolution (milliseconds)
   * @default: 0
   * @description Time resolution of data written to the database. Zero means write all data, 1000 means write each context-path-source combination once per second. Updates arriving more quicker will not be written.
   */
  resolution: number

  /**
   * @title Tag paths
   * @default []
   * @description SK paths whose current values are maintained as tags on every point written.
   * Use this to tag all data with slowly-changing state such as the active sail configuration.
   * Example: [{ "path": "sails.inventory.main.active", "tagName": "sail_config", "defaultValue": "unknown" }]
   */
  tagPaths?: TagPathConfig[]

  /**
   * @title Sail inventory tag
   * @description Builds a canonical sail_config tag from sails.inventory.*.active booleans.
   * Active sail names are sorted alphabetically and joined with '+' (e.g. "jib+main") so the
   * tag value is stable regardless of update order. Mutually exclusive with using tagPaths for
   * sail configuration.
   * Example: { "tagName": "sail_config", "defaultValue": "unknown" }
   */
  sailInventoryTag?: SailInventoryTagConfig

  /**
   * @title Consolidated measurement name
   * @description When set, all values are written to this single InfluxDB measurement using the SK path
   * as the field name, rather than one measurement per path. Makes analytics queries much simpler.
   * Example: "instruments"
   * Note: object-type values (notifications, JSON blobs) are skipped in consolidated mode.
   */
  consolidatedMeasurement?: string

  writeOptions: Partial<WriteOptions>
}

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

export const influxPath = (path: string) => (path !== '' ? path : '<empty>')

enum JsValueType {
  number = 'number',
  string = 'string',
  boolean = 'boolean',
  object = 'object',
}

const VALUETYPECACHE: {
  [key: string]: JsValueType
} = {}

export class SKInflux {
  private influx: InfluxDB
  public org: string
  public bucket: string
  private writeApi: WriteApi
  public queryApi: QueryApi
  public writtenLinesCount = 0
  public failedLinesCount = 0
  public lastWriteCallbackSucceeded = false
  public url: string
  private onlySelf: boolean
  public v1Client: InfluxV1
  private ignoreStatusForPathSources: {
    [path: string]: boolean
  } = {}
  private filteringRules: FilteringRule[]
  private ignoredPaths: string[]
  private ignoredSources: string[]
  private useSKTimestamp: boolean

  private lastWrittenTimestamps: {
    [context: Context]: {
      [path: Path]: {
        [sourceRef: SourceRef]: number
      }
    }
  } = {}
  private resolution: number

  // Tag path support: cache of path → { tagName, current value }
  private tagPathsConfig: TagPathConfig[]
  private tagCache: Map<string, { tagName: string; value: string }> = new Map()

  // Sail inventory tag support
  private sailInventoryTagConfig: SailInventoryTagConfig | undefined
  private activeSails: Set<string> = new Set()

  // Consolidated measurement support
  private consolidatedMeasurement: string | undefined

  constructor(config: SKInfluxConfig, private logging: Logging, triggerStatusUpdate: () => void) {
    const { org, bucket, url, onlySelf, ignoredPaths, ignoredSources, resolution, useSKTimestamp, filteringRules } =
      config
    this.influx = new InfluxDB(config)
    this.org = org
    this.bucket = bucket
    this.url = url
    this.onlySelf = onlySelf
    this.ignoredPaths = ignoredPaths
    this.ignoredSources = ignoredSources
    this.filteringRules = filteringRules || []
    this.useSKTimestamp = useSKTimestamp
    this.resolution = resolution

    // Initialise tag path support
    this.tagPathsConfig = config.tagPaths || []
    this.tagPathsConfig.forEach(({ path, tagName, defaultValue }) => {
      if (defaultValue !== undefined) {
        this.tagCache.set(path, { tagName, value: defaultValue })
      }
    })

    // Initialise sail inventory tag support
    this.sailInventoryTagConfig = config.sailInventoryTag
    if (this.sailInventoryTagConfig) {
      const cfg = this.sailInventoryTagConfig
      if (cfg.enabled === false) {
        this.logging.debug(`[sailInventoryTag] disabled in config — no sail_config tag will be written`)
      } else {
        this.logging.debug(
          `[sailInventoryTag] enabled — watching sails.inventory.*.active, tagName="${cfg.tagName}", defaultValue="${cfg.defaultValue ?? '(none)'}"`
        )
        if (cfg.defaultValue !== undefined) {
          this.tagCache.set('__sailInventory__', {
            tagName: cfg.tagName,
            value: cfg.defaultValue,
          })
        }
      }
    } else {
      this.logging.debug(`[sailInventoryTag] not configured — no sail_config tag will be written`)
    }

    // Initialise consolidated measurement support
    this.consolidatedMeasurement = config.consolidatedMeasurement

    this.writeApi = this.influx.getWriteApi(org, bucket, 'ms', {
      ...config.writeOptions,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      writeFailed: (_error, lines, _attempt, _expires) => {
        this.failedLinesCount += lines.length
        this.lastWriteCallbackSucceeded = false
        triggerStatusUpdate()
      },
      writeSuccess: (lines) => {
        this.writtenLinesCount += lines.length
        this.lastWriteCallbackSucceeded = true
        triggerStatusUpdate()
      },
    })
    this.queryApi = this.influx.getQueryApi(org)
    const parsedUrl = new URL(url)
    this.v1Client = new InfluxV1({
      host: parsedUrl.hostname,
      username: org,
      // leave password empty
      password: '',
      port: Number(parsedUrl.port),
      protocol: <'http' | 'https'>parsedUrl.protocol.slice(0, -1),
      database: bucket,
      options: {
        headers: {
          Authorization: `Token ${config.token}`,
        },
      },
    })
  }

  init() {
    let retryCount = 0
    return new Promise((resolve) => {
      const retryInit = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._init(resolve).catch((e: any) => {
          this.logging.debug(e.message)
          this.logging.debug(`${e.message} retry ${retryCount++}`)
          setTimeout(() => {
            retryInit()
          }, 10 * 1000)
        })
      }
      retryInit()
    })
  }

  async _init(onSuccess: (v: unknown) => void) {
    const bucketId = await ensureBucketExists(this.influx, this.org, this.bucket)
    await this.ensureV1MappingExists(bucketId)
    onSuccess(undefined)
  }
  async ensureV1MappingExists(bucketId: string | undefined) {
    if (!bucketId) {
      throw new Error('No bucketid')
    }
    const dbrsApi = new DbrpsAPI(this.influx)
    const dbrs = await dbrsApi.getDBRPs({ org: this.org })
    if (!dbrs.content) {
      throw new Error('Error retrieving dbrs')
    }
    //is there mapping where v1 database name is the same as bucket
    if (!dbrs.content.find((dbr) => dbr.database === this.bucket)) {
      await dbrsApi.postDBRP({
        body: {
          org: this.org,
          database: this.bucket,
          bucketID: bucketId,
          retention_policy: 'default',
          default: true,
        },
      })
      this.logging.debug(`Created database retention policy`)
    }
  }

  /**
   * Apply all cached tag path values as tags on the given point.
   */
  private applyTagCache(point: Point): void {
    this.tagCache.forEach(({ tagName, value }) => {
      point.tag(tagName, value)
    })
  }

  handleValue(
    context: Context,
    isSelf: boolean,
    sourceRef: SourceRef,
    timestamp: Timestamp | undefined,
    pathValue: PathValue,
    now: number,
  ) {
    if (this.isIgnored(pathValue.path, sourceRef)) {
      return
    }
    if (!this.shouldStoreNow(context, pathValue.path, sourceRef, now)) {
      return
    }

    // Update tag cache if this is a configured tag path
    const tagPathConfig = this.tagPathsConfig.find((tc) => tc.path === pathValue.path)
    if (tagPathConfig && pathValue.value !== null && pathValue.value !== undefined) {
      this.tagCache.set(pathValue.path, {
        tagName: tagPathConfig.tagName,
        value: String(pathValue.value),
      })
    }

    // Update sail inventory tag if this is a sails.inventory.*.active path
    if (this.sailInventoryTagConfig && this.sailInventoryTagConfig.enabled !== false) {
      const match = pathValue.path.match(/^sails\.inventory\.([^.]+)\.active$/)
      if (match) {
        const sailName = match[1]
        const before = new Set(this.activeSails)
        if (pathValue.value === true) {
          this.activeSails.add(sailName)
        } else {
          this.activeSails.delete(sailName)
        }
        const combined =
          this.activeSails.size > 0
            ? [...this.activeSails].sort().join('+')
            : (this.sailInventoryTagConfig.defaultValue ?? 'none')
        this.tagCache.set('__sailInventory__', {
          tagName: this.sailInventoryTagConfig.tagName,
          value: combined,
        })
        this.logging.debug(
          `[sailInventoryTag] ${pathValue.path} = ${pathValue.value} | activeSails: [${[...before].sort().join(', ')}] → [${[...this.activeSails].sort().join(', ')}] | tag ${this.sailInventoryTagConfig.tagName}="${combined}"`
        )
      }
    }

    if (!this.onlySelf || isSelf) {
      this.toPoints(context, isSelf, sourceRef, timestamp, pathValue, this.logging.debug).forEach((point) => {
        this.writeApi.writePoint(point)
        this.updateLastWritten(context, pathValue.path, sourceRef, now)
      })
    }
  }
  updateLastWritten(context: Context, path: Path, sourceRef: SourceRef, now: number) {
    this.lastWrittenTimestamps[context][path][sourceRef] = now
  }

  shouldStoreNow(context: Context, path: Path, sourceRef: SourceRef, now: number) {
    const byContext = this.lastWrittenTimestamps[context] ?? (this.lastWrittenTimestamps[context] = {})
    const byPath = byContext[path] ?? (byContext[path] = {})
    return now - (byPath[sourceRef] || 0) > (this.resolution ?? 0)
  }

  /**
   * Delete last written timestamps by context if the newest timestamp from
   * that context is older than x times resolution
   */
  pruneLastWrittenTimestamps() {
    const now = Date.now()
    Object.entries(this.lastWrittenTimestamps).forEach(([context, byContext]) => {
      const maxTimestamp = Object.values(byContext).reduce<number>((acc, byPath) => {
        return Math.max(
          acc,
          Object.values(byPath).reduce<number>((acc, bySource) => {
            return Math.max(0, bySource)
          }, 0),
        )
      }, 0)
      if (now - maxTimestamp > 100 * this.resolution) {
        delete this.lastWrittenTimestamps[context as Context]
      }
    })
  }

  flush() {
    return this.writeApi.flush()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getValues(params: QueryParams): Promise<Array<any>> {
    return this.queryApi.collectRows(paramsToQuery(this.bucket, params))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSelfValues(params: Omit<QueryParams, 'context'>): Promise<Array<any>> {
    const query = paramsToQuery(this.bucket, params)
    return this.queryApi.collectRows(query)
  }

  isIgnored(path: string, sourceRef: string): boolean {
    const pathSource = `${path}:${sourceRef}`
    let ignoreStatus = this.ignoreStatusForPathSources[pathSource]
    if (ignoreStatus === undefined) {
      ignoreStatus = this.ignoreStatusForPathSources[pathSource] = this.ignoreStatusByConfig(path, sourceRef)
    }
    return ignoreStatus
  }

  ignoreStatusByConfig(path: string, sourceRef: string): boolean {
    if (this.filteringRules?.length > 0) {
      return this.ignoreStatusByRule(path, sourceRef)
    } else {
      return this.ignoreStatusByIgnoredPathOrSource(path, sourceRef)
    }
  }

  ignoreStatusByRule(path: string, sourceRef: string): boolean {
    const firstMatchingRule = this.filteringRules.find((rule) => {
      return (
        (rule.path === undefined || rule.path.length === 0 || new RegExp(rule.path).test(path)) &&
        (rule.source === undefined || rule.source.length === 0 || new RegExp(rule.source).test(sourceRef))
      )
    })
    //ignore if there is a matching rule AND the rule is not an allow rule
    const isIgnored = firstMatchingRule !== undefined && !firstMatchingRule.allow
    this.logging.debug(
      `${path} from ${sourceRef} will be ${isIgnored ? 'ignored' : 'written'}, matching rule is ${JSON.stringify(
        firstMatchingRule,
      )}`,
    )
    return isIgnored
  }

  ignoreStatusByIgnoredPathOrSource(path: string, sourceRef: string): boolean {
    try {
      const ignoredByPath =
        this.ignoredPaths?.reduce<boolean>((acc, ignoredPathExp) => {
          const ignoredPathRegExp = new RegExp(ignoredPathExp.replace(/\./g, '.'))
          const ignored = ignoredPathRegExp.test(path)
          ignored && this.logging.debug(`${path} from ${sourceRef} will be ignored by ${ignoredPathRegExp}`)
          return acc || ignored
        }, false) || false
      const ignoredBySource =
        this.ignoredSources?.reduce<boolean>((acc, ignoredSourceExp) => {
          const ignoredSourceRegExp = new RegExp(ignoredSourceExp.replace(/\./g, '.'))
          const ignored = ignoredSourceRegExp.test(sourceRef)
          ignored && this.logging.debug(`${path} from ${sourceRef} will be ignored by ${ignoredSourceRegExp}`)
          return acc || ignored
        }, false) || false
      return ignoredByPath || ignoredBySource
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this.logging.error(e.message)
      return false
    }
  }

  toPoints(
    context: Context,
    isSelf: boolean,
    source: string,
    timestamp: Timestamp | undefined,
    pathValue: PathValue,
    debug: (s: string) => void,
  ): Point[] {
    // When consolidatedMeasurement is set, all values go to that measurement
    // with the SK path as the field name. Otherwise, use the SK path as the
    // measurement name and 'value' as the field name (original behaviour).
    const measurementName = this.consolidatedMeasurement ?? influxPath(pathValue.path)

    const point = new Point(measurementName).tag('context', context).tag('source', source)
    if (this.useSKTimestamp) {
      point.timestamp(timestamp !== undefined ? new Date(timestamp) : new Date())
    }
    if (isSelf) {
      point.tag(SELF_TAG_NAME, SELF_TAG_VALUE)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = pathValue.value as any
    if (isValidPosition(pathValue)) {
      // Position is always split into lat/lon fields regardless of mode
      point.floatField('lat', value.latitude)
      point.floatField('lon', value.longitude)
      point.tag('s2_cell_id', posToS2CellId(value))
    } else if (pathValue.path === 'navigation.attitude') {
      if (this.consolidatedMeasurement) {
        // Consolidated mode: all attitude components as fields on one point
        let hasField = false
        ;['pitch', 'roll', 'yaw'].forEach((field) => {
          if (isValidFloat(value[field])) {
            point.floatField(`navigation.attitude.${field}`, value[field])
            hasField = true
          }
        })
        if (!hasField) return []
        this.applyTagCache(point)
        return [point]
      } else {
        // Original behaviour: one measurement per attitude component
        return ['pitch', 'roll', 'yaw'].reduce<Point[]>((acc, field) => {
          if (isValidFloat(value[field])) {
            const attPoint = new Point(influxPath(`navigation.attitude.${field}`))
              .tag('context', context)
              .tag('source', source)
            if (isSelf) attPoint.tag(SELF_TAG_NAME, SELF_TAG_VALUE)
            attPoint.floatField('value', value[field])
            this.applyTagCache(attPoint)
            acc.push(attPoint)
          }
          return acc
        }, [])
      }
    } else {
      const valueType = typeFor(pathValue)
      if (value === null) {
        return []
      }
      // In consolidated mode, use the SK path as the field name.
      // In original mode, always use 'value'.
      const fieldName = this.consolidatedMeasurement ? pathValue.path : 'value'
      try {
        switch (valueType) {
          case JsValueType.number:
            point.floatField(fieldName, value)
            break
          case JsValueType.string:
            point.stringField(fieldName, value)
            break
          case JsValueType.boolean:
            point.booleanField(fieldName, value)
            break
          case JsValueType.object:
            if (this.consolidatedMeasurement) {
              // Skip object values in consolidated mode: JSON blobs and
              // notifications pollute an analytics measurement.
              return []
            }
            point.stringField(fieldName, JSON.stringify(value))
        }
      } catch (e) {
        debug(`Error creating point ${pathValue.path}:${pathValue.value} => ${valueType}`)
        return []
      }
    }
    this.applyTagCache(point)
    return [point]
  }
}

const typeFor = (pathValue: PathValue): JsValueType => {
  let r = VALUETYPECACHE[pathValue.path]
  if (!r) {
    r = VALUETYPECACHE[pathValue.path] = _typeFor(pathValue)
  }
  return r
}

const _typeFor = (pathValue: PathValue): JsValueType => {
  if (pathValue.path.startsWith('notifications.')) {
    return JsValueType.object
  }
  const unit = getUnits(`vessels.self.${pathValue.path}`)
  if (unit && unit !== 'RFC 3339 (UTC)') {
    return JsValueType.number
  }
  return typeof pathValue.value as JsValueType
}

const paramsToQuery = (bucket: string, params: PartialBy<QueryParams, 'context'>) => {
  const contextTagClause = params.context
    ? `and r.context == "${params.context}"`
    : `and r.${SELF_TAG_NAME} == "${SELF_TAG_VALUE}"`
  return `
  from(bucket: "${bucket}")
    |> range(start: -10y)
    |> filter(fn: (r) => r["_measurement"] == "${params.paths[0]}" ${contextTagClause})
  `
}

const posToS2CellId = (position: { latitude: number; longitude: number }) => {
  const cell = S2.S2Cell.FromLatLng({ lat: position.latitude, lng: position.longitude }, 10)
  return S2.keyToId(cell.toHilbertQuadkey())
}

function isValidPosition({ path, value }: PathValue): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _value = value as any
  return (
    path === 'navigation.position' &&
    typeof value === 'object' &&
    value !== null &&
    _value.latitude !== null &&
    _value.longitude !== null &&
    !isNaN(_value.latitude) &&
    !isNaN(_value.longitude)
  )
}

function isValidFloat(value: unknown): boolean {
  return typeof value === 'number' && !isNaN(value)
}

async function ensureBucketExists(influx: InfluxDB, org: string, name: string): Promise<string | undefined> {
  const orgsAPI = new OrgsAPI(influx)
  const organizations = await orgsAPI.getOrgs({ org })
  if (!organizations || !organizations.orgs || !organizations.orgs.length) {
    throw new Error(`No organization named "${org}" found!`)
  }
  const orgID = organizations.orgs[0].id || 'no orgid'
  const bucketsAPI = new BucketsAPI(influx)
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const buckets = await bucketsAPI.getBuckets({ orgID, name })
    if (!buckets.buckets) {
      throw new Error('Retrieving buckets failed')
    }
    return buckets.buckets[0].id
  } catch (e) {
    if (e instanceof HttpError && e.statusCode == 404) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const bucket = await bucketsAPI.postBuckets({ body: { orgID, name, retentionRules: [] } })
      // eslint-disable-next-line no-console
      console.log(`Influxdb2: created bucket ${name}`)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const buckets = await bucketsAPI.getBuckets({ orgID, name })
      if (!buckets.buckets) {
        throw new Error('Retrieving buckets failed')
      }
      return buckets.buckets[0].id
    } else {
      throw e
    }
  }
}
