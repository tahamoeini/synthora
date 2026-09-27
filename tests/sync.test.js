import test from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync, webcrypto } from "node:crypto";
import { generateRecoveryKey, prepareSyncCredentials, encryptSnapshot, decryptSnapshot } from "../src/sync.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function fixedRecoveryKey(fill) {
  const bytes = Buffer.alloc(32, fill);
  const check = createHash("sha256")
    .update("synthora:recovery-key-check:v1")
    .update(bytes)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `SYN1-${bytes.toString("hex").toUpperCase().match(/.{8}/g).join("-")}-${check}`;
}

const firstKey = fixedRecoveryKey(0x11);
const secondKey = fixedRecoveryKey(0x22);

test("generated recovery keys contain 256 random bits and a validated checksum", async () => {
  const first = await generateRecoveryKey();
  const second = await generateRecoveryKey();
  assert.match(first, /^SYN1(?:-[0-9A-F]{8}){9}$/);
  assert.notEqual(first, second);
  await assert.doesNotReject(prepareSyncCredentials(first));
  await assert.rejects(prepareSyncCredentials(first.replace(/.$/, first.endsWith("0") ? "1" : "0")), /checksum/);
  await assert.rejects(prepareSyncCredentials("SYN1-short"), /format/);
  await assert.doesNotReject(prepareSyncCredentials(`  ${first.toLowerCase()}  `));
});

test("HKDF derives a stable header token independent from the non-extractable encryption key", async () => {
  const credentials = await prepareSyncCredentials(firstKey);
  const same = await prepareSyncCredentials(firstKey);
  const other = await prepareSyncCredentials(secondKey);
  const expectedToken = Buffer.from(
    hkdfSync("sha256", Buffer.alloc(32, 0x11), "synthora:sync:hkdf:v1", "synthora:sync:auth-token:v1", 32),
  ).toString("base64url");
  assert.equal(credentials.authToken, expectedToken);
  assert.match(credentials.authToken, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  assert.equal(credentials.authToken, same.authToken);
  assert.notEqual(credentials.authToken, other.authToken);
  assert.equal(credentials.encryptionKey.algorithm.name, "AES-GCM");
  assert.equal(credentials.encryptionKey.extractable, false);
  assert.equal("accountId" in credentials, false);
  await assert.rejects(crypto.subtle.exportKey("raw", credentials.encryptionKey));
});

test("versioned JSON personal records round-trip and each encryption uses a fresh IV", async () => {
  const credentials = await prepareSyncCredentials(firstKey);
  const snapshot = {
    profile: { salary: 50_000_000, goal: "بازنشستگی" },
    history: [{ id: "plan-1", value: 25 }],
    portfolio: { transactions: [{ id: "tx-1", amount: 100_000 }] },
    modelSettings: { horizonYears: 10 },
    preferences: { locale: "fa" },
  };
  const first = await encryptSnapshot(snapshot, credentials);
  const second = await encryptSnapshot(snapshot, credentials);
  assert.deepEqual(Object.keys(first), ["version", "iv", "ciphertext"]);
  assert.equal(first.version, 1);
  assert.notEqual(first.iv, second.iv);
  assert.deepEqual(await decryptSnapshot(JSON.parse(JSON.stringify(first)), credentials), snapshot);
  assert.equal(JSON.stringify(first).includes("salary"), false);
});

test("tampered ciphertext and IV, changed version, and wrong key fail closed", async () => {
  const credentials = await prepareSyncCredentials(firstKey);
  const payload = await encryptSnapshot({ profile: { salary: 1 } }, credentials);
  const changeFirstCharacter = (value) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  await assert.rejects(
    decryptSnapshot({ ...payload, ciphertext: changeFirstCharacter(payload.ciphertext) }, credentials),
  );
  await assert.rejects(decryptSnapshot({ ...payload, iv: changeFirstCharacter(payload.iv) }, credentials));
  await assert.rejects(decryptSnapshot({ ...payload, version: 2 }, credentials), /Unsupported/);
  await assert.rejects(decryptSnapshot(payload, await prepareSyncCredentials(secondKey)));
});

test("only explicit personal records are accepted and payload size is bounded", async () => {
  const credentials = await prepareSyncCredentials(firstKey);
  const nearLimit = await encryptSnapshot({ profile: { note: "x".repeat(250_000) } }, credentials);
  assert.ok(Buffer.from(nearLimit.ciphertext, "base64url").length <= 256 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ revision: 0, payload: nearLimit })) <= 360_000);
  await assert.rejects(encryptSnapshot({ marketCache: {} }, credentials), /unsupported record/);
  await assert.rejects(encryptSnapshot({ profile: { apiKey: "sensitive" } }, credentials), /unsupported field/);
  await assert.rejects(encryptSnapshot({ profile: { api_key: "sensitive" } }, credentials), /unsupported field/);
  await assert.rejects(
    encryptSnapshot({ portfolio: { nested: { refreshToken: "sensitive" } } }, credentials),
    /unsupported field/,
  );
  await assert.rejects(encryptSnapshot({ profile: { age: Number.NaN } }, credentials), /JSON values/);
  await assert.rejects(encryptSnapshot({ profile: { note: "x".repeat(256 * 1024) } }, credentials), /too large/);
  await assert.rejects(decryptSnapshot({ version: 1, iv: "A".repeat(100), ciphertext: "AA" }, credentials));
  await assert.rejects(
    decryptSnapshot({ version: 1, iv: "AAAAAAAAAAAAAAAA", ciphertext: "A".repeat(1_400_000) }, credentials),
  );
});
