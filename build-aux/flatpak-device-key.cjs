"use strict";

// Software replacement for the TPM-only Linux addon, implementing its raw-byte
// API. The upstream caller still validates and canonicalizes signed payloads.
// See docs/SECURITY.md: these keys are extractable, including by app commands.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const algorithm = "ecdsa_p256_sha256";
// Protocol compatibility label used by codex-desktop-linux's software provider.
// This is NOT a claim that a PEM on disk has OS-enforced non-extractability.
const protectionClass = "os_protected_nonextractable";
const keyIdPattern = /^flatpak_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function checkStat(stat, directory) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
  ) {
    throw new Error("Unsafe Flatpak remote-control key ownership, type or permissions");
  }
}

function storeDirectory() {
  const root = process.env.XDG_CONFIG_HOME ||
    (process.env.HOME && path.join(process.env.HOME, ".config"));
  if (!root || !path.isAbsolute(root)) {
    throw new Error("Remote-control keys require an absolute config directory");
  }
  // XDG_CONFIG_HOME is already persisted in the Flatpak's private app data.
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, "chatgpt-flatpak-device-keys");
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  checkStat(fs.lstatSync(directory), true);
  return directory;
}

function keyPath(keyId) {
  if (typeof keyId !== "string" || !keyIdPattern.test(keyId)) {
    throw new Error("Invalid Flatpak remote-control key id");
  }
  return path.join(storeDirectory(), `${keyId}.pem`);
}

function readKey(keyId) {
  const fd = fs.openSync(keyPath(keyId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    checkStat(stat, false);
    if (stat.size > 4096) throw new Error("Remote-control key exceeds size limit");
    const key = crypto.createPrivateKey(fs.readFileSync(fd));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1") {
      throw new Error("Remote-control key must be ECDSA P-256");
    }
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function publicInfo(keyId, privateKey) {
  return {
    algorithm,
    keyId,
    protectionClass,
    publicKeySpkiDerBase64: crypto.createPublicKey(privateKey)
      .export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function syncDirectory(filename) {
  let fd;
  try {
    fd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch {
    // The create/delete has already committed. Do not report it as rolled back.
    console.warn("ChatGPT Flatpak: device-key directory sync failed; crash durability is not confirmed.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = {
  async createDeviceKey(policy) {
    if (policy !== "allow_os_protected_nonextractable") {
      throw new Error("Flatpak software device keys cannot satisfy hardware-only protection");
    }
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyId = `flatpak_${crypto.randomUUID()}`;
    const filename = keyPath(keyId);
    // Separate, immutable files avoid shared-store read/modify/write races.
    // The UUID is published only after the complete key has been flushed.
    const fd = fs.openSync(filename, "wx", 0o600);
    try {
      fs.writeFileSync(fd, privateKey.export({ type: "pkcs8", format: "pem" }));
      fs.fsyncSync(fd);
    } catch (error) {
      fs.unlinkSync(filename);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(filename);
    console.warn("ChatGPT Flatpak: remote-control identity uses an extractable local software key.");
    return publicInfo(keyId, privateKey);
  },

  async getDeviceKeyPublic(keyId) {
    return publicInfo(keyId, readKey(keyId));
  },

  async signDeviceKey(keyId, payload) {
    if (!Buffer.isBuffer(payload)) throw new Error("Expected canonical device-key payload bytes");
    return {
      algorithm,
      signatureDerBase64: crypto.sign("sha256", payload, readKey(keyId)).toString("base64"),
    };
  },

  async deleteDeviceKey(keyId) {
    const filename = keyPath(keyId);
    try {
      checkStat(fs.lstatSync(filename), false);
      fs.unlinkSync(filename);
      syncDirectory(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  },
};
