/**
 * SQLite-backed drop-in replacement for the subset of Mongoose this project uses.
 *
 * Why: the game normally talks to MongoDB, which cannot realistically run on a
 * phone. `node:sqlite` ships with Node >= 22.5, so there is no native module to
 * compile — it works on Android/Termux, Windows, macOS and Linux out of the box.
 *
 * Storage model: one row per document in a single `documents` table
 * (collection + id + JSON body). Collections are loaded lazily into memory and
 * every mutation is written through to SQLite, so queries keep full MongoDB
 * operator semantics (regex, dotted paths, $inc on nested Map fields, ...)
 * without needing a query compiler.
 *
 * This is intentionally a *compatibility layer*, not a general purpose ORM:
 * it implements exactly the operations the codebase performs.
 */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

type Doc = Record<string, any>

/**
 * Minimal stand-in for mongoose's `QueryFilter` / `FilterQuery` so callers do
 * not need the mongoose package installed just for a type.
 */
export type FilterOperators<T> = {
  $eq?: T
  $ne?: T
  $gt?: T
  $gte?: T
  $lt?: T
  $lte?: T
  $in?: T[]
  $nin?: T[]
  $exists?: boolean
  $regex?: RegExp | string
  $options?: string
  $size?: number
  $all?: T[]
  $elemMatch?: Doc
  $not?: FilterOperators<T>
}

export type QueryFilter<T = any> = {
  [K in keyof T]?: T[K] | FilterOperators<T[K]>
} & {
  $or?: QueryFilter<T>[]
  $and?: QueryFilter<T>[]
  $nor?: QueryFilter<T>[]
}

const TYPE_TAG = "$__t"

/* -------------------------------------------------------------------------- */
/*  Serialization: JSON cannot represent Map / Buffer / Date / Uint8Array      */
/* -------------------------------------------------------------------------- */

function encodeValue(value: any): any {
  if (value === undefined) return undefined
  if (value === null) return null
  if (value instanceof Date) return { [TYPE_TAG]: "date", v: value.toISOString() }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return {
      [TYPE_TAG]: "buffer",
      v: Buffer.from(value as Uint8Array).toString("base64")
    }
  if (value instanceof Map)
    return {
      [TYPE_TAG]: "map",
      v: [...value.entries()].map(([k, val]) => [k, encodeValue(val)])
    }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (typeof value === "object") {
    const out: Doc = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("$__")) continue // skip internal markers / methods
      const encoded = encodeValue(v)
      if (encoded !== undefined) out[k] = encoded
    }
    return out
  }
  return value
}

function decodeValue(value: any): any {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(decodeValue)
  if (typeof value === "object") {
    const tag = value[TYPE_TAG]
    if (tag === "date") return new Date(value.v)
    if (tag === "buffer") return Buffer.from(value.v, "base64")
    if (tag === "map") {
      const map = new Map<string, any>()
      for (const [k, v] of value.v) map.set(k, decodeValue(v))
      return map
    }
    const out: Doc = {}
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v)
    return out
  }
  return value
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (value instanceof Date) return new Date(value.getTime()) as any
  if (Buffer.isBuffer(value)) return Buffer.from(value) as any
  if (value instanceof Uint8Array) return Buffer.from(value) as any
  if (value instanceof Map) {
    const map = new Map()
    for (const [k, v] of value) map.set(k, clone(v))
    return map as any
  }
  if (Array.isArray(value)) return value.map(clone) as any
  const out: Doc = {}
  for (const [k, v] of Object.entries(value)) out[k] = clone(v)
  return out as any
}

/* -------------------------------------------------------------------------- */
/*  Connection                                                                 */
/* -------------------------------------------------------------------------- */

let database: DatabaseSync | null = null
const stores = new Map<string, Map<string, Doc>>()

function resolveDatabasePath(): string {
  return (
    process.env.SQLITE_PATH ??
    path.join(process.cwd(), "data", "pokemon-auto-chess.db")
  )
}

/** Opens (and creates if needed) the SQLite database file. */
export function connectDB(filePath?: string): DatabaseSync {
  const target = filePath ?? resolveDatabasePath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  database = new DatabaseSync(target)
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("PRAGMA synchronous = NORMAL")
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      coll TEXT NOT NULL,
      id   TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (coll, id)
    )
  `)
  database.exec("CREATE INDEX IF NOT EXISTS idx_documents_coll ON documents(coll)")
  stores.clear()
  return database
}

/** Mongoose-compatible alias: the URI argument is ignored, SQLITE_PATH is used. */
export async function connect(_uri?: string): Promise<void> {
  if (!database) connectDB()
}

export function isConnected(): boolean {
  return database !== null
}

export function closeDB(): void {
  database?.close()
  database = null
  stores.clear()
}

function store(collection: string): Map<string, Doc> {
  let existing = stores.get(collection)
  if (existing) return existing
  const fresh = new Map<string, Doc>()
  if (database) {
    const rows = database
      .prepare("SELECT id, body FROM documents WHERE coll = ?")
      .all(collection) as Array<{ id: string; body: string }>
    for (const row of rows) {
      try {
        fresh.set(row.id, decodeValue(JSON.parse(row.body)))
      } catch {
        // ignore corrupted rows rather than refusing to boot
      }
    }
  }
  stores.set(collection, fresh)
  return fresh
}

function persist(collection: string, doc: Doc): void {
  if (!database) return
  database
    .prepare(
      `INSERT INTO documents (coll, id, body) VALUES (?, ?, ?)
       ON CONFLICT(coll, id) DO UPDATE SET body = excluded.body`
    )
    .run(collection, String(doc._id), JSON.stringify(encodeValue(doc)))
}

function removeRow(collection: string, id: string): void {
  if (!database) return
  database.prepare("DELETE FROM documents WHERE coll = ? AND id = ?").run(collection, id)
}

/* -------------------------------------------------------------------------- */
/*  Schema                                                                     */
/* -------------------------------------------------------------------------- */

export class Schema {
  paths: Doc
  options: Doc
  static Types = {
    Mixed: "Mixed",
    ObjectId: "ObjectId",
    Buffer: Buffer,
    Map: Map,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Date: Date
  }

  constructor(definition: Doc = {}, options: Doc = {}) {
    this.paths = definition
    this.options = options
  }

  index(..._args: any[]): this {
    return this
  }
  virtual(): this {
    return this
  }
  pre(): this {
    return this
  }
  post(): this {
    return this
  }
  static ObjectId = "ObjectId"
}

function defaultFor(definition: any): any {
  if (definition === undefined || definition === null) return undefined
  if (definition instanceof Schema) return undefined
  if (Array.isArray(definition)) return []
  if (typeof definition !== "object") return undefined
  if (definition.type === Map) return new Map()
  if (definition.type === Schema.Types.Mixed) {
    return "default" in definition ? clone(definition.default) : undefined
  }
  if ("default" in definition) {
    return typeof definition.default === "function"
      ? definition.default()
      : clone(definition.default)
  }
  return undefined
}

function applyDefaults(schema: Schema | undefined, source: Doc): Doc {
  const doc: Doc = {}
  const paths = schema?.paths ?? {}
  for (const [key, definition] of Object.entries(paths)) {
    if (key === "_id") continue
    const provided = source[key]
    if (provided !== undefined) {
      doc[key] = clone(provided)
    } else {
      const fallback = defaultFor(definition)
      if (fallback !== undefined) doc[key] = fallback
    }
  }
  // keep fields that are not declared in the schema
  for (const [key, value] of Object.entries(source)) {
    if (key in doc || value === undefined) continue
    if (key.startsWith("$__")) continue
    doc[key] = clone(value)
  }
  return doc
}

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                               */
/* -------------------------------------------------------------------------- */

function getPath(target: any, pathStr: string): any {
  const parts = pathStr.split(".")
  let current = target
  for (const part of parts) {
    if (current === undefined || current === null) return undefined
    current = current instanceof Map ? current.get(part) : current[part]
  }
  return current
}

function setPath(target: any, pathStr: string, value: any): void {
  const parts = pathStr.split(".")
  let current = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    let next = current instanceof Map ? current.get(part) : current[part]
    if (next === undefined || next === null || typeof next !== "object") {
      next = {}
      if (current instanceof Map) current.set(part, next)
      else current[part] = next
    }
    current = next
  }
  const last = parts[parts.length - 1]
  if (current instanceof Map) current.set(last, value)
  else current[last] = value
}

function deletePath(target: any, pathStr: string): void {
  const parts = pathStr.split(".")
  let current = target
  for (let i = 0; i < parts.length - 1; i++) {
    current = current instanceof Map ? current.get(parts[i]) : current?.[parts[i]]
    if (current === undefined || current === null) return
  }
  const last = parts[parts.length - 1]
  if (current instanceof Map) current.delete(last)
  else if (current && typeof current === "object") delete current[last]
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                   */
/* -------------------------------------------------------------------------- */

function equals(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (a instanceof Date || b instanceof Date)
    return new Date(a).getTime() === new Date(b).getTime()
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  if (typeof a === "object" && typeof b === "object")
    return JSON.stringify(encodeValue(a)) === JSON.stringify(encodeValue(b))
  return false
}

const OPERATORS = new Set([
  "$in",
  "$nin",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$exists",
  "$regex",
  "$options",
  "$size",
  "$all",
  "$not",
  "$eq"
])

function matchValue(value: any, condition: any): boolean {
  if (condition instanceof RegExp) return condition.test(String(value ?? ""))

  if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
    const keys = Object.keys(condition)
    if (keys.length > 0 && keys.some((k) => OPERATORS.has(k))) {
      for (const key of keys) {
        const expected = condition[key]
        switch (key) {
          case "$eq":
            if (!equals(value, expected)) return false
            break
          case "$ne":
            if (equals(value, expected)) return false
            break
          case "$in":
            if (!(expected as any[]).some((candidate) => matchValue(value, candidate)))
              return false
            break
          case "$nin":
            if ((expected as any[]).some((candidate) => matchValue(value, candidate)))
              return false
            break
          case "$gt":
            if (!(value != null && compareValues(value, expected) > 0)) return false
            break
          case "$gte":
            if (!(value != null && compareValues(value, expected) >= 0)) return false
            break
          case "$lt":
            if (!(value != null && compareValues(value, expected) < 0)) return false
            break
          case "$lte":
            if (!(value != null && compareValues(value, expected) <= 0)) return false
            break
          case "$exists":
            if (expected ? value === undefined : value !== undefined) return false
            break
          case "$regex": {
            const flags = condition.$options ?? ""
            const regex =
              expected instanceof RegExp ? expected : new RegExp(String(expected), flags)
            if (Array.isArray(value)) {
              if (!value.some((item) => regex.test(String(item)))) return false
            } else if (!regex.test(String(value ?? ""))) return false
            break
          }
          case "$size":
            if (!Array.isArray(value) || value.length !== expected) return false
            break
          case "$all":
            if (!Array.isArray(value)) return false
            if (!(expected as any[]).every((c) => value.some((v) => equals(v, c))))
              return false
            break
          case "$not":
            if (matchValue(value, expected)) return false
            break
          case "$options":
            break
          default:
            return false
        }
      }
      return true
    }
  }

  // equality — MongoDB semantics: an array field matches if it contains the value
  if (Array.isArray(value)) return value.some((item) => equals(item, condition))
  if (value instanceof Map) return equals(value.get(String(condition)), condition)
  return equals(value, condition)
}

function matches(doc: Doc, filter: Doc | undefined): boolean {
  if (!filter) return true
  for (const [key, condition] of Object.entries(filter)) {
    if (condition === undefined) continue
    if (key === "$or") {
      if (!(condition as Doc[]).some((sub) => matches(doc, sub))) return false
      continue
    }
    if (key === "$and") {
      if (!(condition as Doc[]).every((sub) => matches(doc, sub))) return false
      continue
    }
    if (key === "$nor") {
      if ((condition as Doc[]).some((sub) => matches(doc, sub))) return false
      continue
    }
    if (!matchValue(getPath(doc, key), condition)) return false
  }
  return true
}

/* -------------------------------------------------------------------------- */
/*  Sorting / projection                                                       */
/* -------------------------------------------------------------------------- */

function compareValues(a: any, b: any): number {
  if (a === b) return 0
  if (a === undefined || a === null) return 1
  if (b === undefined || b === null) return -1
  if (a instanceof Date) a = a.getTime()
  if (b instanceof Date) b = b.getTime()
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1
  return String(a).localeCompare(String(b))
}

function sortRows(rows: Doc[], spec: Doc): Doc[] {
  const keys = Object.entries(spec)
  if (keys.length === 0) return rows
  return [...rows].sort((left, right) => {
    for (const [key, direction] of keys) {
      const result = compareValues(getPath(left, key), getPath(right, key))
      if (result !== 0) return Number(direction) < 0 ? -result : result
    }
    return 0
  })
}

function project(doc: Doc, spec: Doc | string[] | undefined): Doc {
  if (!spec) return doc
  // mongoose also accepts an array of field names as an inclusion projection
  if (Array.isArray(spec)) {
    const out: Doc = {}
    for (const key of spec) {
      const found = getPath(doc, key)
      if (found !== undefined) setPath(out, key, found)
    }
    if (doc._id !== undefined) out._id = doc._id
    return out
  }
  if (Object.keys(spec).length === 0) return doc
  const entries = Object.entries(spec)
  const inclusive = entries.some(
    ([, value]) => value === 1 || value === true
  )
  if (inclusive) {
    const out: Doc = {}
    for (const [key, value] of entries) {
      if (value === 0 || value === false) continue
      const found = getPath(doc, key)
      if (found !== undefined) setPath(out, key, found)
    }
    if (spec._id !== 0 && spec._id !== false && doc._id !== undefined)
      out._id = doc._id
    return out
  }
  const out = clone(doc)
  for (const [key, value] of entries) {
    if (value === 0 || value === false) deletePath(out, key)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Updates                                                                    */
/* -------------------------------------------------------------------------- */

function applyUpdate(doc: Doc, update: Doc): void {
  for (const [key, value] of Object.entries(update)) {
    if (key === "$set") {
      for (const [pathStr, val] of Object.entries(value as Doc))
        setPath(doc, pathStr, clone(val))
    } else if (key === "$inc") {
      for (const [pathStr, delta] of Object.entries(value as Doc)) {
        const current = getPath(doc, pathStr)
        setPath(doc, pathStr, (Number(current) || 0) + Number(delta))
      }
    } else if (key === "$unset") {
      for (const pathStr of Object.keys(value as Doc)) deletePath(doc, pathStr)
    } else if (key === "$push" || key === "$addToSet") {
      for (const [pathStr, val] of Object.entries(value as Doc)) {
        let current = getPath(doc, pathStr)
        if (!Array.isArray(current)) {
          current = []
          setPath(doc, pathStr, current)
        }
        if (key === "$addToSet") {
          if (!current.some((item: any) => equals(item, val)))
            current.push(clone(val))
        } else {
          current.push(clone(val))
        }
      }
    } else if (key.startsWith("$")) {
      // unsupported operator: ignore instead of corrupting the document
    } else {
      // Mongoose treats bare keys as $set (supports dotted paths)
      setPath(doc, key, clone(value))
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Documents                                                                  */
/* -------------------------------------------------------------------------- */

const HYDRATED = Symbol.for("pac.db.hydrated")

function hydrate(collection: string, raw: Doc): Doc {
  const doc = raw
  if ((doc as any)[HYDRATED]) return doc
  Object.defineProperties(doc, {
    save: {
      enumerable: false,
      configurable: true,
      value: async function () {
        persist(collection, doc)
        return doc
      }
    },
    updateOne: {
      enumerable: false,
      configurable: true,
      value: async function (update: Doc) {
        applyUpdate(doc, update)
        persist(collection, doc)
        return { acknowledged: true, modifiedCount: 1 }
      }
    },
    toObject: {
      enumerable: false,
      configurable: true,
      value: () => clone(doc)
    },
    toJSON: {
      enumerable: false,
      configurable: true,
      value: () => clone(doc)
    },
    isNew: { enumerable: false, configurable: true, writable: true, value: false },
    [HYDRATED]: { enumerable: false, configurable: true, value: true }
  })
  return doc
}

function insertRaw(collection: string, source: Doc, schema?: Schema): Doc {
  const target = store(collection)
  const withDefaults = applyDefaults(schema, source)
  if (withDefaults._id === undefined)
    withDefaults._id = source.id !== undefined ? String(source.id) : randomUUID()
  withDefaults._id = String(withDefaults._id)
  target.set(withDefaults._id, withDefaults)
  persist(collection, withDefaults)
  return withDefaults
}

/* -------------------------------------------------------------------------- */
/*  Query                                                                      */
/* -------------------------------------------------------------------------- */

type QueryOptions = { sort?: Doc; limit?: number; skip?: number; select?: Doc | string[] }

class Query<T = any> implements PromiseLike<T> {
  private options: QueryOptions = {}
  private mode: "many" | "one" | "count"
  private collection: string
  private schema?: Schema
  private filter: Doc
  private hydrateResults: boolean
  private execHook?: (rows: Doc[]) => any

  constructor(
    collection: string,
    schema: Schema | undefined,
    filter: Doc,
    mode: "many" | "one" | "count",
    hydrateResults: boolean,
    execHook?: (rows: Doc[]) => any
  ) {
    this.collection = collection
    this.schema = schema
    this.filter = filter ?? {}
    this.mode = mode
    this.hydrateResults = hydrateResults
    this.execHook = execHook
  }

  sort(spec: Doc): this {
    this.options.sort = spec
    return this
  }
  limit(value: number): this {
    this.options.limit = value
    return this
  }
  skip(value: number): this {
    this.options.skip = value
    return this
  }
  select(spec: Doc | string[]): this {
    this.options.select = spec
    return this
  }
  lean<T = any>(): Query<T> {
    this.hydrateResults = false
    return this as any
  }

  private run(): any {
    let rows = [...store(this.collection).values()].filter((doc) =>
      matches(doc, this.filter)
    )

    if (this.options.sort) rows = sortRows(rows, this.options.sort)
    if (this.options.skip) rows = rows.slice(this.options.skip)
    if (this.options.limit !== undefined)
      rows = rows.slice(0, this.options.limit)

    if (this.mode === "count") return rows.length

    let projected = rows.map((doc) => project(doc, this.options.select))
    if (this.execHook) return this.execHook(projected)

    if (!this.hydrateResults) {
      const plain = projected.map((doc) => clone(doc))
      return this.mode === "one" ? (plain[0] ?? null) : plain
    }

    const hydrated = projected.map((doc) => hydrate(this.collection, doc))
    return this.mode === "one" ? (hydrated[0] ?? null) : hydrated
  }

  exec(): Promise<any> {
    try {
      return Promise.resolve(this.run())
    } catch (error) {
      return Promise.reject(error)
    }
  }
  then<R1 = any, R2 = never>(
    onfulfilled?: ((value: any) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected)
  }
  catch<R = never>(onrejected?: ((reason: any) => R) | null): Promise<any> {
    return this.exec().catch(onrejected)
  }
  finally(onfinally?: (() => void) | null): Promise<any> {
    return this.exec().finally(onfinally)
  }
}

/* -------------------------------------------------------------------------- */
/*  Aggregation (only the stages used by this codebase)                        */
/* -------------------------------------------------------------------------- */

function evalExpression(expression: any, row: Doc): any {
  if (expression === null || expression === undefined) return expression
  if (typeof expression === "string") {
    if (expression.startsWith("$")) return getPath(row, expression.slice(1))
    return expression
  }
  if (Array.isArray(expression)) return expression.map((item) => evalExpression(item, row))
  if (typeof expression !== "object") return expression

  const keys = Object.keys(expression)
  if (keys.length !== 1) {
    const out: Doc = {}
    for (const key of keys) out[key] = evalExpression(expression[key], row)
    return out
  }
  const [operator] = keys
  const operand = expression[operator]
  switch (operator) {
    case "$toDate":
      return new Date(evalExpression(operand, row))
    case "$dateToString": {
      const date = new Date(evalExpression(operand.date, row))
      const format: string = operand.format ?? "%Y-%m-%d"
      const pad = (n: number) => String(n).padStart(2, "0")
      return format
        .replace("%Y", String(date.getUTCFullYear()))
        .replace("%m", pad(date.getUTCMonth() + 1))
        .replace("%d", pad(date.getUTCDate()))
        .replace("%H", pad(date.getUTCHours()))
        .replace("%M", pad(date.getUTCMinutes()))
        .replace("%S", pad(date.getUTCSeconds()))
    }
    case "$ifNull": {
      const value = evalExpression(operand[0], row)
      return value === null || value === undefined
        ? evalExpression(operand[1], row)
        : value
    }
    case "$objectToArray": {
      const value = evalExpression(operand, row)
      if (value instanceof Map)
        return [...value.entries()].map(([k, v]) => ({ k, v }))
      if (value && typeof value === "object")
        return Object.entries(value).map(([k, v]) => ({ k, v }))
      return []
    }
    default:
      return evalExpression(operand, row)
  }
}

function runAggregate(collection: string, pipeline: Doc[]): Doc[] {
  let rows: Doc[] = [...store(collection).values()].map((doc) => clone(doc))

  for (const stage of pipeline) {
    if (stage.$match) {
      rows = rows.filter((row) => matches(row, stage.$match))
    } else if (stage.$sort) {
      rows = sortRows(rows, stage.$sort)
    } else if (stage.$limit !== undefined) {
      rows = rows.slice(0, stage.$limit)
    } else if (stage.$skip !== undefined) {
      rows = rows.slice(stage.$skip)
    } else if (stage.$unwind) {
      const field = String(stage.$unwind).replace(/^\$/, "")
      const unwound: Doc[] = []
      for (const row of rows) {
        const value = getPath(row, field)
        if (Array.isArray(value)) {
          for (const item of value) {
            const copy = clone(row)
            setPath(copy, field, item)
            unwound.push(copy)
          }
        } else if (value !== undefined && value !== null) {
          unwound.push(row)
        }
      }
      rows = unwound
    } else if (stage.$project) {
      const spec = stage.$project
      const hasExpression = Object.values(spec).some(
        (value) => value !== null && typeof value === "object"
      )
      rows = rows.map((row) => {
        const out: Doc = {}
        for (const [key, value] of Object.entries(spec)) {
          if (value === 0 || value === false) continue
          if (value === 1 || value === true) {
            const found = getPath(row, key)
            if (found !== undefined) setPath(out, key, found)
          } else {
            out[key] = evalExpression(value, row)
          }
        }
        if (spec._id !== 0 && !hasExpression && row._id !== undefined) out._id = row._id
        return out
      })
    } else if (stage.$group) {
      const groups = new Map<string, Doc>()
      const idExpression = stage.$group._id
      const accumulators = Object.entries(stage.$group).filter(([key]) => key !== "_id")
      for (const row of rows) {
        const groupKey = evalExpression(idExpression, row)
        const key =
          typeof groupKey === "object" ? JSON.stringify(groupKey) : String(groupKey)
        let bucket = groups.get(key)
        if (!bucket) {
          bucket = { _id: groupKey }
          for (const [field, accumulator] of accumulators) {
            const op = Object.keys(accumulator as Doc)[0]
            bucket[field] = op === "$sum" ? 0 : []
          }
          groups.set(key, bucket)
        }
        for (const [field, accumulator] of accumulators) {
          const op = Object.keys(accumulator as Doc)[0]
          const operand = (accumulator as Doc)[op]
          if (op === "$sum") {
            const value = operand === 1 ? 1 : Number(evalExpression(operand, row)) || 0
            bucket[field] += value
          } else if (op === "$push") {
            bucket[field].push(evalExpression(operand, row))
          } else if (op === "$max") {
            const value = evalExpression(operand, row)
            bucket[field] = bucket[field] === undefined ? value : Math.max(bucket[field], value)
          } else if (op === "$min") {
            const value = evalExpression(operand, row)
            bucket[field] = bucket[field] === undefined ? value : Math.min(bucket[field], value)
          }
        }
      }
      rows = [...groups.values()]
    }
  }
  return rows
}

/* -------------------------------------------------------------------------- */
/*  Model factory                                                              */
/* -------------------------------------------------------------------------- */

export function model<T = any>(
  name: string,
  schema?: Schema,
  collectionName?: string
) {
  const collection = collectionName ?? name

  const Model: any = class {}

  Model.modelName = name
  Model.collectionName = collection
  Model.schema = schema

  Model.find = (filter: Doc = {}, projection?: Doc | string[], options?: Doc) => {
    const query = new Query(collection, schema, filter, "many", true)
    if (projection) query.select(projection)
    if (options?.sort) query.sort(options.sort)
    if (options?.limit !== undefined) query.limit(options.limit)
    if (options?.skip !== undefined) query.skip(options.skip)
    return query
  }

  Model.findOne = (filter: Doc = {}) =>
    new Query(collection, schema, filter, "one", true)

  Model.findById = (id: string) =>
    new Query(collection, schema, { _id: String(id) }, "one", true)

  Model.countDocuments = (filter: Doc = {}) =>
    new Query(collection, schema, filter, "count", false)

  Model.estimatedDocumentCount = async () => store(collection).size

  Model.create = async (input: Doc | Doc[]) => {
    if (Array.isArray(input))
      return input.map((item) => hydrate(collection, insertRaw(collection, item, schema)))
    const raw = insertRaw(collection, input, schema)
    return hydrate(collection, raw)
  }

  Model.insertMany = async (input: Doc[]) =>
    input.map((item) => hydrate(collection, insertRaw(collection, item, schema)))

  Model.updateOne = async (filter: Doc, update: Doc, options?: Doc) => {
    const target = store(collection)
    const found = [...target.values()].filter((doc) => matches(doc, filter))
    if (found.length === 0 && options?.upsert) {
      const seed: Doc = { ...filter }
      applyUpdate(seed, update)
      insertRaw(collection, seed, schema)
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    }
    for (const doc of found) {
      applyUpdate(doc, update)
      persist(collection, doc)
    }
    return {
      acknowledged: true,
      matchedCount: found.length,
      modifiedCount: found.length,
      upsertedCount: 0
    }
  }

  Model.updateMany = Model.updateOne

  Model.findOneAndUpdate = async (filter: Doc, update: Doc, options?: Doc) => {
    const target = store(collection)
    const doc = [...target.values()].find((candidate) => matches(candidate, filter))
    if (!doc) {
      if (options?.upsert) {
        const seed: Doc = { ...filter }
        applyUpdate(seed, update)
        return hydrate(collection, insertRaw(collection, seed, schema))
      }
      return null
    }
    applyUpdate(doc, update)
    persist(collection, doc)
    return options?.new === false ? hydrate(collection, clone(doc)) : hydrate(collection, doc)
  }

  Model.deleteOne = async (filter: Doc) => {
    const target = store(collection)
    const doc = [...target.values()].find((candidate) => matches(candidate, filter))
    if (!doc) return { acknowledged: true, deletedCount: 0 }
    target.delete(String(doc._id))
    removeRow(collection, String(doc._id))
    return { acknowledged: true, deletedCount: 1 }
  }

  Model.deleteMany = async (filter: Doc) => {
    const target = store(collection)
    const doomed = [...target.values()].filter((doc) => matches(doc, filter))
    for (const doc of doomed) {
      target.delete(String(doc._id))
      removeRow(collection, String(doc._id))
    }
    return { acknowledged: true, deletedCount: doomed.length }
  }

  Model.aggregate = (pipeline: Doc[]) =>
    new Query(collection, schema, {}, "many", false, (rows) =>
      runAggregate(collection, pipeline)
    )

  // mongoose exposes the raw driver collection; only aggregate() is used here
  Model.collection = {
    aggregate: (pipeline: Doc[]) => ({
      toArray: async () => runAggregate(collection, pipeline),
      exec: async () => runAggregate(collection, pipeline)
    })
  }

  Model.hydrate = (doc: Doc) => hydrate(collection, applyDefaults(schema, doc))

  return Model as any
}

export default { connect, connectDB, model, Schema }

/* -------------------------------------------------------------------------- */
/*  Types kept for call sites that imported them from mongoose                 */
/* -------------------------------------------------------------------------- */

export type HydratedDocument<T> = T & {
  _id: string
  save(): Promise<any>
  toObject(): any
  toJSON(): any
  updateOne(update: Doc): Promise<any>
}

export namespace mongo {
  export interface DeleteResult {
    acknowledged: boolean
    deletedCount: number
  }
  export interface UpdateResult {
    acknowledged: boolean
    matchedCount: number
    modifiedCount: number
    upsertedCount: number
  }
}
