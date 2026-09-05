/**
 * Pure (no shell-outs, no network) CloudKit record decoding/encoding
 * helpers - shared by ckWebService.ts (which does the actual REST calls)
 * and workoutStore.ts. Split out from the old cktool.ts so these have
 * nothing to do with any particular transport.
 */

export interface CKFieldValue {
  type: string;
  value: unknown;
}

export interface CKRawRecord {
  recordType: string;
  recordName: string;
  fields: Record<string, CKFieldValue>;
}

/** Plain record with the `CD_` prefix stripped and values unwrapped from their `{type, value}` envelope. */
export type PlainRecord = Record<string, unknown>;

/**
 * Flattens a raw CloudKit record (as returned by `records/query`/`records/modify`)
 * into a plain key/value object. `TIMESTAMP` fields come back from the REST API
 * as raw epoch-millisecond numbers, but every call site in workoutStore.ts reads
 * date fields via `asString(...)` (an ISO 8601 string) - matching what the old
 * `cktool`-backed version produced - so they're converted here rather than at
 * every read site.
 */
export function flattenRecord(record: CKRawRecord): PlainRecord {
  const plain: PlainRecord = { recordName: record.recordName };
  for (const [key, field] of Object.entries(record.fields)) {
    const strippedKey = key.startsWith("CD_") ? key.slice(3) : key;
    plain[strippedKey] = field.type === "TIMESTAMP" && typeof field.value === "number" ? new Date(field.value).toISOString() : field.value;
  }
  return plain;
}

/**
 * Decodes a base64 `bytesType` field that SwiftData encoded as a plain JSON
 * array of raw enum strings (this is how `[MuscleGroup]`/`[Equipment]`-style
 * array attributes come across - verified empirically against real synced
 * records, as opposed to single-enum attributes which use the much heavier
 * NSKeyedArchiver encoding handled by `decodeSingleEnumBytes` below).
 */
export function decodeStringArrayBytes(base64Value: unknown): string[] {
  if (typeof base64Value !== "string" || base64Value.length === 0) return [];
  try {
    const json = Buffer.from(base64Value, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Encodes a plain string array as the same `bytesType` shape SwiftData
 * uses for `[MuscleGroup]`/`[Equipment]`-style attributes - verified
 * against real synced records to be plain base64-encoded JSON (see
 * `decodeStringArrayBytes` above), so producing it is just the reverse.
 */
export function encodeStringArrayBytes(values: string[]): string {
  return Buffer.from(JSON.stringify(values), "utf-8").toString("base64");
}

/**
 * Decodes a base64 `bytesType` field holding a single non-optional custom
 * enum (e.g. `ExerciseCategory`, `MovementPattern`). SwiftData boxes these
 * as a full NSKeyedArchiver binary plist rather than plain JSON, which is
 * substantial machinery to fully parse just for one short string. Since
 * each enum here only ever has a small, fixed, non-overlapping set of raw
 * values (see Shared/Enums.swift), it's simpler and just as reliable to
 * decode the payload as raw bytes and check which known candidate string
 * appears in it - NSKeyedArchiver stores short string values as literal
 * UTF-8 bytes inside the binary plist, with no obfuscation.
 */
export function decodeSingleEnumBytes(base64Value: unknown, candidates: readonly string[]): string | undefined {
  if (typeof base64Value !== "string" || base64Value.length === 0) return undefined;
  const decoded = Buffer.from(base64Value, "base64").toString("latin1");
  return candidates.find((candidate) => decoded.includes(candidate));
}

/**
 * Decodes a `[String]` model attribute that SwiftData stored via the
 * `NSSecureUnarchiveFromData` transformer - i.e. an `NSKeyedArchiver` binary
 * plist of an `NSArray<NSString>`, NOT the plain base64 JSON used by
 * `[MuscleGroup]`/`[Equipment]` (see `decodeStringArrayBytes`). Used to read
 * back `NutritionMeal.ingredients`, the exact counterpart of
 * `encodeArchivedStringArrayBytes` in `nsKeyedArchiver.ts`. Falls back to the
 * plain-JSON decoder for legacy/other encodings and returns `[]` on anything
 * it can't parse (readback is best-effort; the app reads these natively).
 */
export function decodeArchivedStringArrayBytes(base64Value: unknown): string[] {
  if (typeof base64Value !== "string" || base64Value.length === 0) return [];
  const buffer = Buffer.from(base64Value, "base64");
  if (buffer.subarray(0, 8).toString("latin1") !== "bplist00") {
    // Not a keyed archive - most likely the older plain-JSON encoding.
    return decodeStringArrayBytes(base64Value);
  }
  return (archivedRootArrayElements(buffer) ?? []).filter((value): value is string => typeof value === "string");
}

/**
 * Decodes an `[Int]` model attribute stored via the same
 * `NSSecureUnarchiveFromData` transformer as the strings above - the exact
 * counterpart of `encodeIntArrayBytes` in `nsKeyedArchiver.ts`, used to read
 * back `WorkoutExercise.targetRepsPerSet`.
 *
 * Same archive skeleton as the string case (`$top.root` -> an array whose
 * `NS.objects` holds one reference per element), so it shares the walk and
 * only differs in which element type it keeps. Returns `[]` on anything
 * unparseable, matching the best-effort convention above - a template whose
 * per-set rep scheme can't be read is reported as having none rather than
 * failing the whole read.
 */
export function decodeArchivedIntArrayBytes(base64Value: unknown): number[] {
  if (typeof base64Value !== "string" || base64Value.length === 0) return [];
  const buffer = Buffer.from(base64Value, "base64");
  if (buffer.subarray(0, 8).toString("latin1") !== "bplist00") return [];
  return (archivedRootArrayElements(buffer) ?? []).filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
}

/**
 * Walks an `NSKeyedArchiver` archive of a root array and returns its
 * elements with each reference resolved, or `undefined` if the payload isn't
 * that shape. Element typing is left to the caller.
 */
function archivedRootArrayElements(buffer: Buffer): unknown[] | undefined {
  try {
    const plist = parseBinaryPlist(buffer);
    const objects = plist.top["$objects"];
    if (!Array.isArray(objects)) return undefined;
    const rootUid = (plist.top["$top"] as Record<string, unknown> | undefined)?.root as { uid?: number } | undefined;
    if (rootUid?.uid === undefined) return undefined;
    const rootObject = objects[rootUid.uid] as Record<string, unknown> | undefined;
    const nsObjects = rootObject?.["NS.objects"];
    if (!Array.isArray(nsObjects)) return undefined;
    return nsObjects.map((entry) =>
      entry && typeof entry === "object" && "uid" in entry ? objects[(entry as { uid: number }).uid] : undefined
    );
  } catch {
    return undefined;
  }
}

interface ParsedBinaryPlist {
  top: Record<string, unknown>;
}

/**
 * Minimal binary-plist (`bplist00`) reader - just enough to walk an
 * `NSKeyedArchiver` archive of an array of strings. Handles the marker types
 * that show up in that payload (null/bool, ints, ASCII/UTF-16 strings, UIDs,
 * arrays, dicts); anything else parses to `null`.
 */
function parseBinaryPlist(buffer: Buffer): ParsedBinaryPlist {
  const trailer = buffer.length - 32;
  const offsetIntSize = buffer.readUInt8(trailer + 6);
  const objectRefSize = buffer.readUInt8(trailer + 7);
  const numObjects = Number(buffer.readBigUInt64BE(trailer + 8));
  const topObject = Number(buffer.readBigUInt64BE(trailer + 16));
  const offsetTableOffset = Number(buffer.readBigUInt64BE(trailer + 24));

  const readSized = (offset: number, size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buffer.readUInt8(offset + i);
    return value;
  };

  const offsetTable: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    offsetTable.push(readSized(offsetTableOffset + i * offsetIntSize, offsetIntSize));
  }

  const parseAt = (index: number): unknown => {
    let offset = offsetTable[index];
    const marker = buffer.readUInt8(offset);
    const objType = marker & 0xf0;
    const objInfo = marker & 0x0f;
    offset += 1;

    const readCount = (): number => {
      if (objInfo !== 0x0f) return objInfo;
      const intMarker = buffer.readUInt8(offset);
      const intSize = 1 << (intMarker & 0x0f);
      offset += 1;
      const count = readSized(offset, intSize);
      offset += intSize;
      return count;
    };

    switch (objType) {
      case 0x00:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x10: {
        const size = 1 << objInfo;
        return readSized(offset, size);
      }
      case 0x50: {
        const length = readCount();
        return buffer.toString("latin1", offset, offset + length);
      }
      case 0x60: {
        const length = readCount();
        return swapUtf16(buffer.subarray(offset, offset + length * 2));
      }
      case 0x80: {
        const size = objInfo + 1;
        return { uid: readSized(offset, size) };
      }
      case 0xa0: {
        const count = readCount();
        const result: unknown[] = [];
        for (let i = 0; i < count; i++) {
          result.push(parseAt(readSized(offset + i * objectRefSize, objectRefSize)));
        }
        return result;
      }
      case 0xd0: {
        const count = readCount();
        const keys: unknown[] = [];
        for (let i = 0; i < count; i++) keys.push(parseAt(readSized(offset + i * objectRefSize, objectRefSize)));
        const valuesStart = offset + count * objectRefSize;
        const dict: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const value = parseAt(readSized(valuesStart + i * objectRefSize, objectRefSize));
          dict[String(keys[i])] = value;
        }
        return dict;
      }
      default:
        return null;
    }
  };

  const top = parseAt(topObject);
  return { top: (top && typeof top === "object" ? top : {}) as Record<string, unknown> };
}

/** Big-endian UTF-16 (as stored in a bplist) -> JS string. */
function swapUtf16(bytes: Buffer): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return swapped.toString("utf16le");
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
