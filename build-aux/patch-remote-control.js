#!/usr/bin/env node
"use strict";

// Outbound control only, inspired by ilysenko/codex-desktop-linux (see README).
// Upstream 26.915.31945: expose Connections, load the remote catalog, show the
// outbound tab, and substitute the TPM addon with our private software store.
// Keep authentication, backend availability/access checks, payload validation,
// pairing, host enablement and SSH execution unchanged. Every replacement has
// the same byte length; validate all changes before writing anything to ASAR.
const crypto = require("node:crypto");
const fs = require("node:fs");

function fail(message) {
  throw new Error(message);
}

function padded(before, after) {
  if (Buffer.byteLength(after) > Buffer.byteLength(before)) fail("replacement grew");
  return after + " ".repeat(Buffer.byteLength(before) - Buffer.byteLength(after));
}

function gate(source, id, marker, count) {
  const pattern = new RegExp(`[A-Za-z_$][\\w$]*\\((?:[A-Za-z_$][\\w$]*,)?\`${id}\`\\)`, "g");
  const matches = [...source.matchAll(pattern)];
  const patched = source.split(marker).length - 1;
  if (matches.length === 0 && patched === count) return source;
  if (matches.length !== count || patched !== 0) fail(`unexpected gate ${id}; review the upstream bundle`);
  return source.replace(pattern, before => padded(before, marker));
}

function patchSource(kind, source) {
  if (kind === "main") {
    // Keep the wrapper's signedPayloadBase64 and canonical payload validation.
    for (const anchor of [
      "Remote control device keys require resourcesPath",
      "codex-device-key-sign-payload/v1",
      "Invalid remote-control device-key connection audience",
      "Invalid remote-control device-key enrollment audience",
      "this.getAddon().signDeviceKey(",
    ]) {
      if (!source.includes(anchor)) fail(`device-key wrapper changed: ${anchor}`);
    }
    const before = "`remote-control-device-key.node`";
    const after = padded(before, "`flatpak-device-key.cjs`");
    if (!source.includes(before) && source.split(after).length === 2) return source;
    if (source.split(before).length !== 2 || source.includes("flatpak-device-key.cjs")) {
      fail("expected exactly one native device-key filename");
    }
    return source.replace(before, after);
  }
  if (kind === "initial") {
    for (const anchor of [
      "[remote-connections/gate-bridge]",
      "set-remote-control-connections-enabled",
      "slingshotEnabled:",
      "?.available??!0)&&",
      "?.accessRequired!==!0",
    ]) {
      if (!source.includes(anchor)) fail(`remote catalog contract changed: ${anchor}`);
    }
    source = gate(source, "4114442250", "!0/*fp-nav*/", 2);
    // Both the loader hook and the enablement bridge must agree; changing
    // visibility alone leaves the main process with an empty catalog.
    return gate(source, "1042620455", "!0/*fp-rc*/", 2);
  }
  const owners = [...source.matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(`782640499`\)/g)];
  if (owners.length !== 1) fail("outbound tab gate owner changed");
  const owner = owners[0][1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`([A-Za-z_$][\\w$]*=)!(?:${owner}|0) *(?=,[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*==null)`, "g");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) fail("outbound tab gate consumer changed");
  source = source.replace(pattern, (before, prefix) => padded(before, `${prefix}!0`));
  // Opening the shared Connections section also exposes the local-host tab.
  // Hide that unsupported setup while retaining outbound and SSH tabs.
  const tabs = /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&!([01]),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&\(\2\|\|!1\),([A-Za-z_$][\w$]*)=\2&&!0,/g;
  const tabMatches = [...source.matchAll(tabs)];
  if (tabMatches.length !== 1 || !source.includes(`showControlThisMacTab:${tabMatches[0][1]}`)) {
    fail("local-host tab contract changed");
  }
  return source.replace(tabs, (before, localTab, section) =>
    before.replace(`${localTab}=${section}&&!0`, `${localTab}=${section}&&!1`));
}

function walk(node, prefix = "", files = []) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, path, files);
    else files.push({ path, entry });
  }
  return files;
}

function read(fd, length, position) {
  const bytes = Buffer.alloc(length);
  if (fs.readSync(fd, bytes, 0, length, position) !== length) fail("truncated ASAR");
  return bytes;
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function run() {
  const args = process.argv.slice(2);
  const mode = args[0]?.startsWith("--") ? args.shift() : "write";
  if (!["write", "--check", "--verify"].includes(mode) || args.length !== 1) {
    fail("usage: patch-remote-control.js [--check|--verify] APP.ASAR");
  }
  const fd = fs.openSync(args[0], mode === "write" ? "r+" : "r");
  try {
    const prelude = read(fd, 16, 0);
    const headerSize = prelude.readUInt32LE(12);
    const dataOffset = 8 + prelude.readUInt32LE(4);
    if (prelude.readUInt32LE(0) !== 4 || headerSize === 0 ||
        headerSize > 64 << 20 || dataOffset < 16 + headerSize) fail("unsupported ASAR header");
    const header = JSON.parse(read(fd, headerSize, 16).toString("utf8"));
    const files = walk(header);
    const targets = [
      ["main", /^\.vite\/build\/main-[^/]+\.js$/],
      ["initial", /^webview\/assets\/app-initial-[^/]+\.js$/],
      ["settings", /^webview\/assets\/remote-connections-settings-[^/]+\.js$/],
    ];
    const writes = [];
    for (const [kind, pattern] of targets) {
      const matches = files.filter(file => pattern.test(file.path));
      if (matches.length !== 1) fail(`expected one ${kind} bundle, found ${matches.length}`);
      const { entry, path } = matches[0];
      const position = dataOffset + Number(entry.offset);
      if (entry.unpacked || entry.offset == null || !Number.isSafeInteger(position) ||
          position < dataOffset || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
        fail(`unsupported entry: ${path}`);
      }
      const original = read(fd, entry.size, position);
      const contents = Buffer.from(patchSource(kind, original.toString("utf8")));
      if (contents.length !== original.length) fail(`rewrite changed size: ${path}`);
      const integrity = entry.integrity;
      if (integrity?.algorithm !== "SHA256" || !Number.isSafeInteger(integrity.blockSize) ||
          integrity.blockSize <= 0) fail(`unsupported integrity: ${path}`);
      // Validate even in check mode, before any file is modified.
      const digest = hash(original);
      const blocks = [];
      for (let offset = 0; offset < original.length; offset += integrity.blockSize) {
        blocks.push(hash(original.subarray(offset, offset + integrity.blockSize)));
      }
      if (integrity.hash !== digest || JSON.stringify(integrity.blocks) !== JSON.stringify(blocks)) {
        fail(`integrity mismatch: ${path}`);
      }
      if (contents.equals(original)) continue;
      integrity.hash = hash(contents);
      integrity.blocks = [];
      for (let offset = 0; offset < contents.length; offset += integrity.blockSize) {
        integrity.blocks.push(hash(contents.subarray(offset, offset + integrity.blockSize)));
      }
      writes.push({ contents, position, path });
    }
    const updatedHeader = Buffer.from(JSON.stringify(header));
    if (updatedHeader.length !== headerSize) fail("integrity update changed header length");
    if (mode === "--verify" && writes.length) fail("outbound remote control is not fully patched");
    if (mode === "write" && writes.length) {
      for (const { contents, position } of writes) fs.writeSync(fd, contents, 0, contents.length, position);
      fs.writeSync(fd, updatedHeader, 0, updatedHeader.length, 16);
      fs.fsyncSync(fd);
    }
    console.log(`patch-remote-control: ${writes.length ? mode === "--check" ? "would patch" : "patched" : "already patched"} (${writes.length} bundles)`);
  } finally {
    fs.closeSync(fd);
  }
}

try {
  run();
} catch (error) {
  console.error(`patch-remote-control: ${error.message}`);
  process.exitCode = 1;
}
