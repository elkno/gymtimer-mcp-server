import { readFileSync } from "node:fs";
import { flattenRecord, type CKRawRecord, type PlainRecord } from "./ckCodec.js";
import { API_TOKEN_PATH, CONTAINER_ID, ENVIRONMENT, WEB_AUTH_TOKEN_PATH } from "./config.js";

const ZONE_NAME = "com.apple.coredata.cloudkit.zone";

function readTokenFile(filePath: string, friendlyName: string): string {
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    throw new Error(
      `Could not read ${friendlyName} from ${filePath}. Run ./setup.sh (or 'npm run doctor' to see what's missing) - see README.md's install section.`
    );
  }
}

/**
 * Every read/write in this server goes through CloudKit Web Services'
 * classic REST API (`api.apple-cloudkit.com`), authenticated the same way
 * CloudKit JS does in a browser: a per-app API token (shared once by
 * whoever owns the container) plus a per-user "web auth token" obtained
 * via a one-time interactive Apple ID sign-in redirect (see
 * `scripts/get-web-auth-token.mjs`). Neither of these requires CloudKit
 * Console access or Apple Developer team membership - unlike the old
 * `cktool`-based approach this replaced, which needed a "User Token" only
 * mintable by someone with dashboard access to this specific container.
 */
async function postCK(endpoint: string, body: unknown): Promise<any> {
  const apiToken = readTokenFile(API_TOKEN_PATH, "CloudKit API token");
  const webAuthToken = readTokenFile(WEB_AUTH_TOKEN_PATH, "CloudKit web auth token");

  const url =
    `https://api.apple-cloudkit.com/database/1/${encodeURIComponent(CONTAINER_ID)}/${ENVIRONMENT}/private/${endpoint}` +
    `?ckAPIToken=${encodeURIComponent(apiToken)}&ckWebAuthToken=${encodeURIComponent(webAuthToken)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let json: any;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const reason = json?.reason ?? rawText;
    const looksLikeAuthFailure =
      response.status === 401 || json?.serverErrorCode === "AUTHENTICATION_REQUIRED" || /expired|not authenticated/i.test(String(reason));
    if (looksLikeAuthFailure) {
      throw new Error(
        `CloudKit ${endpoint} authentication failed - your web auth token has likely expired. ` +
          "Fix: run ./refresh-tokens.sh in the gymtimer-mcp-server folder, then restart your MCP client. " +
          `(If that doesn't help, confirm this server is pointed at the right CloudKit environment - currently "${ENVIRONMENT}" - ` +
          "since a token minted for the other one fails identically. See README.md's \"When it stops working\" section.) " +
          "Original error: " +
          reason
      );
    }
    throw new Error(`CloudKit ${endpoint} failed (HTTP ${response.status}): ${reason}`);
  }
  if (json === undefined) {
    throw new Error(`CloudKit ${endpoint} returned a non-JSON response: ${rawText.slice(0, 500)}`);
  }
  return json;
}

interface CKFieldInput {
  value: unknown;
  type?: string;
}

export interface ModifyRecordRequest {
  recordName: string;
  recordType: string;
  fields: Record<string, CKFieldInput>;
  /** "forceUpdate" ignores conflicts (no recordChangeTag needed) - fine for personal, low-concurrency use. */
  operationType?: "create" | "update" | "forceUpdate" | "forceDelete";
}

interface CKModifyResponse {
  records: Array<
    | { recordName: string; recordChangeTag?: string; fields?: Record<string, CKFieldInput> }
    | { recordName: string; serverErrorCode: string; reason: string }
  >;
}

/** Issues a raw `records/modify` call - the one operation that can update an existing record's fields in place (`forceUpdate`). */
export async function modifyRecord(request: ModifyRecordRequest): Promise<void> {
  const json = (await postCK("records/modify", {
    operations: [
      {
        operationType: request.operationType ?? "forceUpdate",
        record: { recordName: request.recordName, recordType: request.recordType, fields: request.fields }
      }
    ],
    zoneID: { zoneName: ZONE_NAME }
  })) as CKModifyResponse;

  const result = json.records?.[0];
  if (result && "serverErrorCode" in result) {
    throw new Error(`CloudKit records/modify failed for ${request.recordName}: ${result.reason}`);
  }
}

export interface CKAssetValue {
  fileChecksum: string;
  size: number;
  receipt: string;
  referenceChecksum?: string;
  wrappingKey?: string;
}

/**
 * Uploads a local file as a CloudKit asset and returns the asset value
 * dictionary (`{fileChecksum, size, receipt, ...}`) to embed in a
 * `records/modify` field of type `ASSETID`. CloudKit Web Services'
 * "Uploading Assets (assets/upload)" is a two-step dance: request an
 * upload URL for the field, then POST the raw bytes to it and get back
 * the asset dictionary. `recordName` is omitted for a brand-new record
 * that doesn't have one yet (see `createRecord` below).
 */
export async function uploadAsset(recordType: string, fieldName: string, fileData: Buffer, recordName?: string): Promise<CKAssetValue> {
  const tokenJson = await postCK("assets/upload", {
    zoneID: { zoneName: ZONE_NAME },
    tokens: [{ recordType, fieldName, ...(recordName ? { recordName } : {}) }]
  });
  const uploadUrl = tokenJson?.tokens?.[0]?.url;
  if (!uploadUrl) {
    throw new Error(`CloudKit assets/upload (requesting upload URL) failed for ${recordType}.${fieldName}: ${JSON.stringify(tokenJson)}`);
  }

  const uploadResponse = await fetch(uploadUrl, { method: "POST", body: new Blob([Uint8Array.from(fileData)]) });
  const uploadRawText = await uploadResponse.text();
  let uploadJson: { singleFile?: CKAssetValue; serverErrorCode?: string; reason?: string } | undefined;
  try {
    uploadJson = JSON.parse(uploadRawText);
  } catch {
    // fall through - uploadRawText itself becomes the error reason below
  }
  if (!uploadResponse.ok || uploadJson?.serverErrorCode || !uploadJson?.singleFile) {
    const reason = uploadJson?.reason ?? uploadRawText;
    throw new Error(`CloudKit asset upload (sending file bytes) failed for ${recordType}.${fieldName}: ${reason}`);
  }
  return uploadJson.singleFile;
}

interface CKQueryResponse {
  records: CKRawRecord[];
  continuationMarker?: string;
}

/**
 * Runs one `records/query` call (with pagination) for a given Core Data +
 * CloudKit record type, filtered to its entity name so we don't need a
 * Queryable index on `___recordID` itself. Every model in this app is
 * mirrored into the exact same custom zone, so callers never need to pass
 * one explicitly. Replaces the old `cktool query-records`-backed `fetchAll`.
 */
export async function queryRecords(recordType: string, entityName: string): Promise<PlainRecord[]> {
  const results: PlainRecord[] = [];
  let continuationMarker: string | undefined;

  do {
    const body: Record<string, unknown> = {
      zoneID: { zoneName: ZONE_NAME },
      query: {
        recordType,
        filterBy: [{ fieldName: "CD_entityName", comparator: "EQUALS", fieldValue: { value: entityName, type: "STRING" } }]
      },
      resultsLimit: 200
    };
    if (continuationMarker) body.continuationMarker = continuationMarker;

    const json = (await postCK("records/query", body)) as CKQueryResponse;
    for (const record of json.records ?? []) {
      results.push(flattenRecord(record));
    }
    continuationMarker = json.continuationMarker;
  } while (continuationMarker);

  return results;
}

// classic CloudKit Web Services REST field type strings (UPPERCASE) - see
// createRecord() below for why callers can keep passing the old cktool
// camelCase names.
const FIELD_TYPE_MAP: Record<string, string> = {
  stringType: "STRING",
  bytesType: "BYTES",
  timestampType: "TIMESTAMP",
  doubleType: "DOUBLE",
  int64Type: "INT64",
  assetType: "ASSETID"
};

function mapFieldType(type: string | undefined): string {
  if (!type) return "STRING";
  return FIELD_TYPE_MAP[type] ?? type;
}

/**
 * Creates a brand-new record via `records/modify` (`operationType: "create"`).
 * Field `type`s may be passed using either the old `cktool` camelCase
 * names (`stringType`/`bytesType`/...) - kept so call sites written
 * against the old `cktool`-backed version don't need to change - or the
 * classic REST API's own UPPERCASE names directly; both are normalized
 * here. `timestampType`/`TIMESTAMP` values are accepted as ISO 8601
 * strings (like the old `cktool` version took) and converted to the
 * epoch-milliseconds number REST actually requires.
 *
 * `assetFiles` maps a field-value placeholder key (referenced from a
 * `{"type": "assetType", "value": KEY}` field in `fields`) to a local file
 * path - each such field is uploaded via `uploadAsset` (no `recordName`
 * yet, since the record doesn't exist) before the create call is made,
 * mirroring what `cktool create-record --asset-files` did automatically.
 */
export async function createRecord(
  recordType: string,
  fields: Record<string, { value: unknown; type?: string }>,
  assetFiles?: Record<string, string>
): Promise<string> {
  const restFields: Record<string, CKFieldInput> = {};

  for (const [fieldName, field] of Object.entries(fields)) {
    const restType = mapFieldType(field.type);

    if (restType === "ASSETID" && assetFiles && typeof field.value === "string" && field.value in assetFiles) {
      const filePath = assetFiles[field.value];
      const asset = await uploadAsset(recordType, fieldName, readFileSync(filePath));
      restFields[fieldName] = { type: "ASSETID", value: asset };
      continue;
    }

    if (restType === "TIMESTAMP" && typeof field.value === "string") {
      restFields[fieldName] = { type: "TIMESTAMP", value: new Date(field.value).getTime() };
      continue;
    }

    restFields[fieldName] = { type: restType, value: field.value };
  }

  const json = (await postCK("records/modify", {
    operations: [{ operationType: "create", record: { recordType, fields: restFields } }],
    zoneID: { zoneName: ZONE_NAME }
  })) as CKModifyResponse;

  const result = json.records?.[0];
  if (!result || "serverErrorCode" in result) {
    const reason = result && "reason" in result ? result.reason : "no record returned";
    throw new Error(`CloudKit records/modify (create) failed for a new ${recordType}: ${reason}`);
  }
  return result.recordName;
}

/** Deletes a record via `records/modify` (`operationType: "forceDelete"`) - ignores conflicts, matching `cktool delete-record --yes`'s old behavior. */
export async function deleteRecord(recordName: string): Promise<void> {
  const json = (await postCK("records/modify", {
    operations: [{ operationType: "forceDelete", record: { recordName } }],
    zoneID: { zoneName: ZONE_NAME }
  })) as CKModifyResponse;

  const result = json.records?.[0];
  if (result && "serverErrorCode" in result) {
    throw new Error(`CloudKit records/modify (forceDelete) failed for ${recordName}: ${result.reason}`);
  }
}