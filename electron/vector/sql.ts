/**
 * The narrowest database surface the vector store needs.
 *
 * Deliberately structural rather than `better-sqlite3`'s `Database` type: the
 * store is then usable against the real Electron database in production AND
 * against a plain `node:sqlite` handle in tests, so retrieval can be proven
 * with a genuine SQLite round trip instead of a hand-rolled fake.
 *
 * Both implementations satisfy it — `better-sqlite3` returns `Buffer` for
 * BLOBs and `node:sqlite` returns `Uint8Array`, so every BLOB read goes
 * through `toFloat32` rather than assuming either.
 */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
}

/** Column names returned by SQL are case-preserved but driver-dependent. */
export type Row = Record<string, unknown>;

/** Read a row value case-insensitively — SQLite drivers disagree on casing. */
export function col(row: Row, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  return undefined;
}

export function str(row: Row, name: string, fallback = ''): string {
  const v = col(row, name);
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function num(row: Row, name: string, fallback = 0): number {
  const v = col(row, name);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Serialise a Float32Array into a compact little-endian BLOB. */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
}

/** Read a BLOB column back into a Float32Array. Returns null on a shape mismatch. */
export function toFloat32(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (value instanceof Uint8Array) {
    if (value.byteLength % 4 !== 0) return null;
    // Copy into a fresh, correctly-aligned buffer: the source may be a view
    // into a larger pool whose byteOffset is not a multiple of 4.
    const out = new Float32Array(value.byteLength / 4);
    new Uint8Array(out.buffer).set(value);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    // Same alignment guard as the Uint8Array branch: a byteLength that is not
    // a multiple of 4 makes the Float32Array constructor throw a RangeError,
    // which would break this function's "return null on shape mismatch"
    // contract instead of degrading.
    if (value.byteLength % 4 !== 0) return null;
    return new Float32Array(value.slice(0));
  }
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
    return new Float32Array(value as number[]);
  }
  return null;
}
