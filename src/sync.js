// Browser-only sync primitives. The caller owns consent, transport, and conflict handling.
const KEY_PREFIX = "SYN1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SNAPSHOT_VERSION = 1;
// The current sync endpoint accepts at most 256 KiB of ciphertext, including the GCM tag.
const MAX_SNAPSHOT_BYTES = 256 * 1024 - 16;
const MAX_DEPTH = 64;
const ALLOWED_RECORDS = new Set(["profile", "history", "portfolio", "modelSettings", "preferences"]);
const FORBIDDEN_FIELD =
  /apikey|providerkey|token|cookie|cache|credential|secret|password|privatekey|session|authorization|bearer|oauth/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const keyCheckDomain = encoder.encode("synthora:recovery-key-check:v1");
const hkdfSalt = encoder.encode("synthora:sync:hkdf:v1");
const authInfo = encoder.encode("synthora:sync:auth-token:v1");
const encryptionInfo = encoder.encode("synthora:sync:aes-gcm:v1");
const associatedData = encoder.encode("synthora:sync:snapshot:v1");

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function bytesFromHex(value) {
  return Uint8Array.from(value.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

function base64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value, maxBytes) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 2
  ) {
    throw new TypeError("Invalid sync payload encoding");
  }
  let binary;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new TypeError("Invalid sync payload encoding");
  }
  if (binary.length > maxBytes) throw new RangeError("Sync payload is too large");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new TypeError("Invalid sync payload encoding");
  return bytes;
}

async function checksum(keyBytes) {
  const input = new Uint8Array(keyCheckDomain.length + keyBytes.length);
  input.set(keyCheckDomain);
  input.set(keyBytes, keyCheckDomain.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)).subarray(0, 4));
}

async function parseRecoveryKey(key) {
  const normalized = typeof key === "string" ? key.trim().toUpperCase() : "";
  if (!/^SYN1(?:-[0-9A-F]{8}){9}$/.test(normalized)) {
    throw new TypeError("Invalid recovery key format");
  }
  const groups = normalized.split("-");
  const keyBytes = bytesFromHex(groups.slice(1, 9).join(""));
  if ((await checksum(keyBytes)) !== groups[9]) throw new TypeError("Invalid recovery key checksum");
  return keyBytes;
}

function copyJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new RangeError("Sync snapshot is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
      throw new TypeError("Sync snapshot must contain JSON values");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !("value" in Object.getOwnPropertyDescriptor(value, index))) {
        throw new TypeError("Sync snapshot must contain JSON values");
      }
    }
    return value.map((entry) => copyJson(entry, depth + 1));
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Sync snapshot must contain JSON values");
  }
  const result = {};
  for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      ["__proto__", "constructor", "prototype"].includes(field) ||
      FORBIDDEN_FIELD.test(field.replace(/[^A-Za-z0-9]/g, "").toLowerCase())
    ) {
      throw new TypeError("Sync snapshot contains an unsupported field");
    }
    result[field] = copyJson(descriptor.value, depth + 1);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Sync snapshot must contain JSON values");
  return result;
}

function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(snapshot))
  ) {
    throw new TypeError("Sync snapshot must be a personal-record object");
  }
  const fields = Object.keys(snapshot);
  if (!fields.length || fields.some((field) => !ALLOWED_RECORDS.has(field))) {
    throw new TypeError("Sync snapshot contains an unsupported record");
  }
  return copyJson(snapshot);
}

function encryptionKeyFrom(credentials) {
  if (!credentials || !credentials.encryptionKey) throw new TypeError("Sync credentials are required");
  return credentials.encryptionKey;
}

/** Returns a copyable 256-bit key with a four-byte SHA-256 typo checksum. */
export async function generateRecoveryKey() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const groups = hex(keyBytes).match(/.{8}/g);
  const check = await checksum(keyBytes);
  keyBytes.fill(0);
  return [KEY_PREFIX, ...groups, check].join("-");
}

/** Keep authToken out of URLs and logs; send it only in a protected authorization header. */
export async function prepareSyncCredentials(key) {
  const keyBytes = await parseRecoveryKey(key);
  try {
    const baseKey = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
    const authBits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: authInfo }, baseKey, 256),
    );
    const authToken = base64Url(authBits);
    authBits.fill(0);
    const encryptionBits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: encryptionInfo },
        baseKey,
        256,
      ),
    );
    const encryptionKey = await crypto.subtle.importKey("raw", encryptionBits, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    encryptionBits.fill(0);
    return Object.freeze({ authToken, encryptionKey });
  } finally {
    keyBytes.fill(0);
  }
}

/** Encrypts only the personal record groups explicitly supplied by the caller. */
export async function encryptSnapshot(snapshot, credentials) {
  const records = validateSnapshot(snapshot);
  const plaintext = encoder.encode(JSON.stringify({ version: SNAPSHOT_VERSION, records }));
  try {
    if (plaintext.length > MAX_SNAPSHOT_BYTES) throw new RangeError("Sync snapshot is too large");
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData, tagLength: 128 },
      encryptionKeyFrom(credentials),
      plaintext,
    );
    return { version: SNAPSHOT_VERSION, iv: base64Url(iv), ciphertext: base64Url(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
}

/** Rejects malformed, oversized, unsupported, or unauthenticated snapshots. */
export async function decryptSnapshot(payload, credentials) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(",") !== "ciphertext,iv,version" ||
    payload.version !== SNAPSHOT_VERSION
  ) {
    throw new TypeError("Unsupported sync payload");
  }
  const iv = fromBase64Url(payload.iv, IV_BYTES);
  if (iv.length !== IV_BYTES) throw new TypeError("Invalid sync payload IV");
  const ciphertext = fromBase64Url(payload.ciphertext, MAX_SNAPSHOT_BYTES + 16);
  if (ciphertext.length < 16) throw new TypeError("Invalid sync payload ciphertext");
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: associatedData, tagLength: 128 },
      encryptionKeyFrom(credentials),
      ciphertext,
    ),
  );
  try {
    if (plaintext.length > MAX_SNAPSHOT_BYTES) throw new RangeError("Sync snapshot is too large");
    const decoded = JSON.parse(decoder.decode(plaintext));
    if (
      !decoded ||
      decoded.version !== SNAPSHOT_VERSION ||
      Object.keys(decoded).sort().join(",") !== "records,version"
    ) {
      throw new TypeError("Unsupported sync snapshot");
    }
    return validateSnapshot(decoded.records);
  } finally {
    plaintext.fill(0);
  }
}
