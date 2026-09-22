"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const providerPath = path.resolve(__dirname, "../build-aux/flatpak-device-key.cjs");
const keys = require(providerPath);

test("software identity: signatures, persistence, deletion and unsafe stores", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "device-key-test-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    await assert.rejects(keys.createDeviceKey("hardware_only"), /hardware-only/);
    assert.deepEqual(fs.readdirSync(root), []);
    const [first, second] = await Promise.all([
      keys.createDeviceKey("allow_os_protected_nonextractable"),
      keys.createDeviceKey("allow_os_protected_nonextractable"),
    ]);
    assert.notEqual(first.keyId, second.keyId);
    assert.equal(first.algorithm, "ecdsa_p256_sha256");
    assert.equal(first.protectionClass, "os_protected_nonextractable");
    assert.ok(!JSON.stringify(first).includes("PRIVATE KEY"));
    assert.deepEqual(await keys.getDeviceKeyPublic(first.keyId), first);
    const filename = path.join(root, "chatgpt-flatpak-device-keys", `${first.keyId}.pem`);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);

    // This is the byte contract used by the upstream canonicalizing wrapper.
    const payload = Buffer.from(JSON.stringify({
      domain: "codex-device-key-sign-payload/v1",
      payload: { type: "remoteControlClientEnrollment", nonce: "test", label: "café 中文" },
    }));
    const signature = await keys.signDeviceKey(first.keyId, payload);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(first.publicKeySpkiDerBase64, "base64"), type: "spki", format: "der",
    });
    assert.equal(publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
    assert.ok(crypto.verify("sha256", payload, publicKey, Buffer.from(signature.signatureDerBase64, "base64")));
    assert.ok(!crypto.verify("sha256", Buffer.from("tampered"), publicKey, Buffer.from(signature.signatureDerBase64, "base64")));
    await assert.rejects(keys.signDeviceKey(first.keyId, "not bytes"), /payload bytes/);
    const restarted = spawnSync(process.execPath, ["-e",
      "require(process.argv[1]).getDeviceKeyPublic(process.argv[2]).then(x=>console.log(JSON.stringify(x)))",
      providerPath, first.keyId], { encoding: "utf8" });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), first);

    for (const badId of ["../outside", "", "__proto__", first.keyId + "/other"]) {
      await assert.rejects(keys.getDeviceKeyPublic(badId), /Invalid/);
      await assert.rejects(keys.deleteDeviceKey(badId), /Invalid/);
    }
    fs.chmodSync(filename, 0o644);
    await assert.rejects(keys.getDeviceKeyPublic(first.keyId), /Unsafe/);
    fs.chmodSync(filename, 0o600);
    fs.linkSync(filename, filename + ".link");
    await assert.rejects(keys.getDeviceKeyPublic(first.keyId), /Unsafe/);
    fs.unlinkSync(filename + ".link");
    const pem = fs.readFileSync(filename);
    fs.unlinkSync(filename);
    fs.symlinkSync(`${second.keyId}.pem`, filename);
    await assert.rejects(keys.getDeviceKeyPublic(first.keyId));
    await assert.rejects(keys.deleteDeviceKey(first.keyId), /Unsafe/);
    fs.unlinkSync(filename);
    fs.writeFileSync(filename, "invalid key", { mode: 0o600 });
    await assert.rejects(keys.getDeviceKeyPublic(first.keyId));
    fs.writeFileSync(filename, Buffer.alloc(4097));
    await assert.rejects(keys.getDeviceKeyPublic(first.keyId), /size limit/);
    fs.writeFileSync(filename, pem);
    fs.chmodSync(path.dirname(filename), 0o755);
    await assert.rejects(keys.signDeviceKey(first.keyId, payload), /Unsafe/);
    fs.chmodSync(path.dirname(filename), 0o700);
    await keys.deleteDeviceKey(first.keyId);
    await keys.deleteDeviceKey(first.keyId);
    await assert.rejects(keys.signDeviceKey(first.keyId, payload), /ENOENT/);
    assert.deepEqual(await keys.getDeviceKeyPublic(second.keyId), second);
    await keys.deleteDeviceKey(second.keyId);
    fs.rmdirSync(path.dirname(filename));
    fs.symlinkSync(root, path.dirname(filename));
    await assert.rejects(keys.createDeviceKey("allow_os_protected_nonextractable"), /Unsafe/);
  } finally {
    if (previous == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
