/**
 * Pure-TypeScript writer for the exact NSKeyedArchiver binary-plist shape
 * SwiftData's `NSSecureUnarchiveFromData` transformer produces for a
 * `[Int]` or `[String]` model attribute (used for `targetRepsPerSet` and
 * `NutritionMeal.ingredients`) - i.e. the byte-for-byte equivalent of:
 *
 *   NSKeyedArchiver.archivedData(withRootObject: values as NSArray, requiringSecureCoding: true)
 *
 * Replaces the old approach of shelling out to a locally-built
 * `GymTimerAgent.app` (via `xcodebuild`) to get SwiftData to do this
 * encoding itself - that required a full Xcode + the whole app source
 * tree, which made the MCP server impossible to run on a machine that
 * only has this folder. This format is stable, well-documented Apple
 * plumbing (unchanged across many OS versions), so reimplementing it here
 * is safe.
 *
 * Verified byte-for-byte identical to real `NSKeyedArchiver` output
 * (captured via a standalone `swift` script calling the exact API above)
 * across: empty arrays, single/multi-element arrays, ASCII and non-ASCII
 * (UTF-16) strings, zero/negative/large ints, and - importantly - arrays
 * with duplicate values (see "orphan object" note below).
 *
 * ## The object graph
 *
 * NSKeyedArchiver's binary plist always has the same skeleton for a
 * `[String]`/`[Int]` root array:
 *
 *   { "$version": 100000, "$archiver": "NSKeyedArchiver",
 *     "$top": { "root": UID(1) },
 *     "$objects": ["$null", <array-repr>, <element>, ..., <class-repr>] }
 *
 * where `<array-repr>` is `{ "NS.objects": [UID(i), ...], "$class": UID(j) }`
 * and `<class-repr>` is `{ "$classname": "NSArray", "$classes": ["NSArray", "NSObject"] }`.
 * Every `UID(n)` is itself its own small object in the *outer* bplist
 * object table (CFBinaryPlist's `0x80`-marker type), separate from the
 * archiver-level `$objects` array's own contents.
 *
 * ## The "orphan object" quirk
 *
 * When the same value (string or int) appears more than once in the input
 * array, real NSKeyedArchiver reuses the *same* underlying `$objects`
 * entry and the *same* archiver-level reference for every repeat (so
 * `$objects` never contains duplicate content) - but it still allocates a
 * brand new, unreferenced `UID`-box object in the outer object table for
 * every repeat beyond the first. This is a harmless implementation
 * artifact (NSKeyedUnarchiver only ever follows reachable references, so
 * an orphaned object has zero effect on decoding) but it does change the
 * exact byte layout, so `encodeElements` below reproduces it deliberately
 * to stay byte-identical with real output.
 */

type PlistNode =
  | { kind: "ascii-str"; value: string }
  | { kind: "utf16-str"; value: string }
  | { kind: "int"; value: number }
  | { kind: "uid"; value: number }
  | { kind: "array"; items: number[] }
  | { kind: "dict"; entries: Array<[number, number]> };

type ElementKind = "str" | "int";

/** Builds the outer object table (see file header) for one root array, in the exact order real NSKeyedArchiver would allocate it. */
class ArchiverGraphBuilder {
  private readonly outer: PlistNode[] = [];
  private readonly scalarIndexByKey = new Map<string, number>();
  private readonly archiverIndexByKey = new Map<string, number>();
  private readonly queue: Array<{ archiverIndex: number; kind: "element"; elementKind: ElementKind; value: string | number } | { archiverIndex: number; kind: "class"; className: string }> = [];
  private nextArchiverIndex = 1;

  private reserve(): number {
    this.outer.push(undefined as unknown as PlistNode);
    return this.outer.length - 1;
  }

  private set(index: number, node: PlistNode): void {
    this.outer[index] = node;
  }

  private addStringScalar(value: string): number {
    const key = `str:${value}`;
    const existing = this.scalarIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const isAscii = Array.from(value).every((ch) => (ch.codePointAt(0) ?? 0) < 128);
    const index = this.reserve();
    this.set(index, isAscii ? { kind: "ascii-str", value } : { kind: "utf16-str", value });
    this.scalarIndexByKey.set(key, index);
    return index;
  }

  private addIntScalar(value: number): number {
    const key = `int:${value}`;
    const existing = this.scalarIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.reserve();
    this.set(index, { kind: "int", value });
    this.scalarIndexByKey.set(key, index);
    return index;
  }

  /** Allocates a NEW, non-deduped outer object for a UID box - see the "orphan object" note above for why this deliberately does not reuse an existing box. */
  private addFreshUidBox(archiverIndex: number): number {
    const index = this.reserve();
    this.set(index, { kind: "uid", value: archiverIndex });
    return index;
  }

  private addDedupedUidBox(archiverIndex: number): number {
    const key = `uid:${archiverIndex}`;
    const existing = this.scalarIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.addFreshUidBox(archiverIndex);
    this.scalarIndexByKey.set(key, index);
    return index;
  }

  /** Returns the archiver-level reference index for an element value, deduping equal values (queues its content for later encoding on first sight). */
  private archiverIndexForElement(elementKind: ElementKind, value: string | number): { archiverIndex: number; isNewValue: boolean } {
    const key = `${elementKind}:${value}`;
    const existing = this.archiverIndexByKey.get(key);
    if (existing !== undefined) return { archiverIndex: existing, isNewValue: false };
    const archiverIndex = ++this.nextArchiverIndex;
    this.archiverIndexByKey.set(key, archiverIndex);
    this.queue.push({ archiverIndex, kind: "element", elementKind, value });
    return { archiverIndex, isNewValue: true };
  }

  private archiverIndexForClass(className: string): number {
    const key = `class:${className}`;
    const existing = this.archiverIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const archiverIndex = ++this.nextArchiverIndex;
    this.archiverIndexByKey.set(key, archiverIndex);
    this.queue.push({ archiverIndex, kind: "class", className });
    return archiverIndex;
  }

  build(elementKind: ElementKind, values: Array<string | number>): PlistNode[] {
    const rootFileDictIdx = this.reserve();
    const versionKeyIdx = this.addStringScalar("$version");
    const archiverKeyIdx = this.addStringScalar("$archiver");
    const topKeyIdx = this.addStringScalar("$top");
    const objectsKeyIdx = this.addStringScalar("$objects");
    const versionValIdx = this.addIntScalar(100000);
    const archiverValIdx = this.addStringScalar("NSKeyedArchiver");

    const topDictIdx = this.reserve();
    const rootKeyIdx = this.addStringScalar("root");
    const rootUidIdx = this.addDedupedUidBox(1);
    this.set(topDictIdx, { kind: "dict", entries: [[rootKeyIdx, rootUidIdx]] });

    const objectsArrayIdx = this.reserve();
    this.set(rootFileDictIdx, {
      kind: "dict",
      entries: [
        [versionKeyIdx, versionValIdx],
        [archiverKeyIdx, archiverValIdx],
        [topKeyIdx, topDictIdx],
        [objectsKeyIdx, objectsArrayIdx]
      ]
    });

    const nullOuterIdx = this.addStringScalar("$null");
    const objectsList: number[] = [nullOuterIdx];

    // Encode the root object (archiver index 1): the NSArray itself.
    const rootArrayDictIdx = this.reserve();
    const nsObjectsKeyIdx = this.addStringScalar("NS.objects");
    const classKeyIdx = this.addStringScalar("$class");
    const nsObjectsArrayIdx = this.reserve();

    const firstBoxIndexByArchiverIndex = new Map<number, number>();
    const elementUidBoxIndices: number[] = [];
    for (const value of values) {
      const { archiverIndex, isNewValue } = this.archiverIndexForElement(elementKind, value);
      // Always allocate a fresh box (even for a repeat) to reproduce the
      // orphan-object quirk described in the file header.
      const boxIdx = this.addFreshUidBox(archiverIndex);
      if (isNewValue) {
        firstBoxIndexByArchiverIndex.set(archiverIndex, boxIdx);
        elementUidBoxIndices.push(boxIdx);
      } else {
        elementUidBoxIndices.push(firstBoxIndexByArchiverIndex.get(archiverIndex) as number);
      }
    }
    this.set(nsObjectsArrayIdx, { kind: "array", items: elementUidBoxIndices });

    const classArchiverIndex = this.archiverIndexForClass("NSArray");
    const classUidBoxIdx = this.addDedupedUidBox(classArchiverIndex);
    this.set(rootArrayDictIdx, {
      kind: "dict",
      entries: [
        [nsObjectsKeyIdx, nsObjectsArrayIdx],
        [classKeyIdx, classUidBoxIdx]
      ]
    });
    objectsList[1] = rootArrayDictIdx;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      let contentIdx: number;
      if (item.kind === "element") {
        contentIdx = item.elementKind === "str" ? this.addStringScalar(item.value as string) : this.addIntScalar(item.value as number);
      } else {
        const classDictIdx = this.reserve();
        const classnameKeyIdx = this.addStringScalar("$classname");
        const classesKeyIdx = this.addStringScalar("$classes");
        const classnameValIdx = this.addStringScalar(item.className);
        const classesArrayIdx = this.reserve();
        const nsObjectClassNameIdx = this.addStringScalar("NSObject");
        // $classes is a plain metadata array (direct outer refs), unlike
        // NS.objects/UID-boxed archiver references above.
        this.set(classesArrayIdx, { kind: "array", items: [classnameValIdx, nsObjectClassNameIdx] });
        this.set(classDictIdx, {
          kind: "dict",
          entries: [
            [classnameKeyIdx, classnameValIdx],
            [classesKeyIdx, classesArrayIdx]
          ]
        });
        contentIdx = classDictIdx;
      }
      objectsList[item.archiverIndex] = contentIdx;
    }

    this.set(objectsArrayIdx, { kind: "array", items: objectsList });
    return this.outer;
  }
}

function unsignedWidthBytes(maxValue: number): number {
  if (maxValue < 0x100) return 1;
  if (maxValue < 0x10000) return 2;
  if (maxValue < 0x100000000) return 4;
  return 8;
}

function intWidthBytes(value: number): number {
  if (value < 0) return 8;
  if (value < 0x100) return 1;
  if (value < 0x10000) return 2;
  if (value < 0x100000000) return 4;
  return 8;
}

function objInfoForPow2Width(width: number): number {
  switch (width) {
    case 1:
      return 0;
    case 2:
      return 1;
    case 4:
      return 2;
    default:
      return 3;
  }
}

function writeBEUnsigned(buffer: Buffer, value: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) {
    buffer[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

/** Encodes the built object graph into real `bplist00` bytes. */
function encodeGraphToBytes(outer: PlistNode[]): Buffer {
  const refSize = unsignedWidthBytes(outer.length - 1);

  function writeRef(index: number): Buffer {
    const buffer = Buffer.alloc(refSize);
    writeBEUnsigned(buffer, index, refSize);
    return buffer;
  }

  function writeCountedMarker(baseNibbleType: number, count: number): Buffer {
    if (count < 15) return Buffer.from([baseNibbleType | count]);
    const width = intWidthBytes(count);
    const pow2 = objInfoForPow2Width(width);
    const countBuf = Buffer.alloc(width);
    writeBEUnsigned(countBuf, count, width);
    return Buffer.concat([Buffer.from([baseNibbleType | 0x0f, 0x10 | pow2]), countBuf]);
  }

  const encoded = outer.map((node): Buffer => {
    switch (node.kind) {
      case "ascii-str": {
        const marker = writeCountedMarker(0x50, node.value.length);
        return Buffer.concat([marker, Buffer.from(node.value, "latin1")]);
      }
      case "utf16-str": {
        const littleEndian = Buffer.from(node.value, "utf16le");
        const bigEndian = Buffer.alloc(littleEndian.length);
        for (let i = 0; i + 1 < littleEndian.length; i += 2) {
          bigEndian[i] = littleEndian[i + 1];
          bigEndian[i + 1] = littleEndian[i];
        }
        const marker = writeCountedMarker(0x60, littleEndian.length / 2);
        return Buffer.concat([marker, bigEndian]);
      }
      case "int": {
        const width = intWidthBytes(node.value);
        const pow2 = objInfoForPow2Width(width);
        const buffer = Buffer.alloc(width);
        if (node.value < 0) {
          buffer.writeBigInt64BE(BigInt(node.value));
        } else {
          writeBEUnsigned(buffer, node.value, width);
        }
        return Buffer.concat([Buffer.from([0x10 | pow2]), buffer]);
      }
      case "uid": {
        // UID width is nibble+1 (linear), not a power of two like "int" above.
        const width = intWidthBytes(node.value);
        const buffer = Buffer.alloc(width);
        writeBEUnsigned(buffer, node.value, width);
        return Buffer.concat([Buffer.from([0x80 | (width - 1)]), buffer]);
      }
      case "array": {
        const marker = writeCountedMarker(0xa0, node.items.length);
        return Buffer.concat([marker, ...node.items.map(writeRef)]);
      }
      case "dict": {
        const marker = writeCountedMarker(0xd0, node.entries.length);
        const keyRefs = node.entries.map(([key]) => writeRef(key));
        const valueRefs = node.entries.map(([, value]) => writeRef(value));
        return Buffer.concat([marker, ...keyRefs, ...valueRefs]);
      }
    }
  });

  const header = Buffer.from("bplist00", "latin1");
  let cursor = header.length;
  const offsets: number[] = [];
  for (const buffer of encoded) {
    offsets.push(cursor);
    cursor += buffer.length;
  }
  const offsetTableOffset = cursor;
  const offsetIntSize = unsignedWidthBytes(Math.max(offsetTableOffset, ...offsets));

  const offsetTableBufs = offsets.map((offset) => {
    const buffer = Buffer.alloc(offsetIntSize);
    writeBEUnsigned(buffer, offset, offsetIntSize);
    return buffer;
  });

  const trailer = Buffer.alloc(32);
  trailer[6] = offsetIntSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(outer.length), 8);
  trailer.writeBigUInt64BE(BigInt(0), 16); // topObject is always the root file dict, outer index 0.
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);

  return Buffer.concat([header, ...encoded, ...offsetTableBufs, trailer]);
}

function encodeElements(elementKind: ElementKind, values: Array<string | number>): Buffer {
  const outer = new ArchiverGraphBuilder().build(elementKind, values);
  return encodeGraphToBytes(outer);
}

/** Encodes a plain array of integers the same way SwiftData would for a `var x: [Int] = []` model attribute (used for `targetRepsPerSet`). Returns base64. */
export function encodeIntArrayBytes(values: number[]): string {
  return encodeElements("int", values).toString("base64");
}

/**
 * Encodes a plain array of strings the same way SwiftData would for a
 * `var x: [String] = []` model attribute (used for `NutritionMeal.ingredients`).
 * Returns base64. `entity`/`field` are accepted (and ignored) to keep the
 * same call signature the old `xcodebuild`-backed implementation had.
 */
export function encodeArchivedStringArrayBytes(_entity: string, _field: string, values: string[]): string {
  return encodeElements("str", values).toString("base64");
}
