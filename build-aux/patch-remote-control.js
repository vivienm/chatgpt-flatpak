#!/usr/bin/env node
"use strict";

// Outbound control only, inspired by ilysenko/codex-desktop-linux (see README).
// Expose Connections, load the remote catalog, show the outbound tab, and
// substitute the TPM addon with our private software store.
// Keep authentication, backend availability/access checks, payload validation,
// pairing, host enablement and SSH execution unchanged. Every replacement has
// the same byte length; validate all changes before writing anything to ASAR.
const crypto = require("node:crypto");
const fs = require("node:fs");
const IDENT = "[A-Za-z_$][\\w$]*";
const MEMBER = `${IDENT}(?:\\.${IDENT})?`;
const CALL = `(?:${IDENT}|\\(0,${IDENT}\\.${IDENT}\\))`;
const CATALOG_BINDINGS = `\\blet (${IDENT})="1042620455",(${IDENT})="4114442250",`;
const NAV_MARKER = "!0/*fp-nav*/";
const REMOTE_MARKER = "!0/*fp-rc*/";

function fail(message) {
  throw new Error(message);
}

function padded(before, after) {
  if (Buffer.byteLength(after) > Buffer.byteLength(before)) fail("replacement grew");
  return after + " ".repeat(Buffer.byteLength(before) - Buffer.byteLength(after));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gate(source, id, marker, count) {
  const pattern = new RegExp(`${CALL}\\((?:${MEMBER},)?([\`\"])${id}\\1\\)`, "g");
  const matches = [...source.matchAll(pattern)];
  const patched = source.split(marker).length - 1;
  if (matches.length === 0 && patched === count) return source;
  if (matches.length !== count || patched !== 0) fail(`unexpected gate ${id}; review the upstream bundle`);
  return source.replace(pattern, before => padded(before, marker));
}

function scopedGate(source, prefix, expression, suffix, marker, count, name) {
  const pattern = new RegExp(`(${prefix})(${expression}|${escapeRegex(marker)} *)(?=${suffix})`, "g");
  const matches = [...source.matchAll(pattern)];
  const patched = matches.filter(match => match[2].startsWith(marker)).length;
  if (matches.length !== count || (patched !== 0 && patched !== count)) {
    fail(`unexpected ${name}; review the upstream bundle`);
  }
  return source.replace(pattern, (_, start, before) => start + padded(before, marker));
}

function patchSharedCatalog(source) {
  const bindings = [...source.matchAll(new RegExp(CATALOG_BINDINGS, "g"))];
  if (bindings.length !== 1) fail("expected exactly one shared remote catalog declaration");
  const [declaration, remote, nav] = bindings[0];
  const start = bindings[0].index + declaration.length;
  const end = source.indexOf("enabledRemoteHostIdSet:", start);
  if (end < 0 || end - start > 2000) fail("shared remote catalog contract changed");
  const owner = source.slice(start, end);
  if (!owner.includes('"features.remote_connections"')) {
    fail("shared remote catalog contract changed");
  }
  // Calls with minified aliases need shorter markers to preserve byte offsets.
  const getter = `${CALL}\\(${MEMBER},${escapeRegex(nav)}\\)`;
  const navigation = scopedGate(owner, `return ${IDENT}\\(${IDENT}\\??\\.config,`, getter, "\\)",
    "!0/*fn*/", 2, "shared catalog navigation gates");
  // The same module exports the gate ID to other callers. Patch only the hook.
  const hook = `${CALL}\\(${escapeRegex(remote)}\\)`;
  const patched = scopedGate(navigation, `,${IDENT}:function\\(\\)\\{return`, hook, "\\}",
    "!0/*fr*/", 1, "shared catalog rollout hook");
  return source.slice(0, start) + patched + source.slice(end);
}

function patchCatalogState(source) {
  return scopedGate(source, "if\\(", `${CALL}\\(${MEMBER},"4114442250"\\)`,
    `\\)return"enabled";if\\(${IDENT}\\.isLoading\\)return"loading"`,
    NAV_MARKER, 1, "catalog navigation state gate");
}

function settingsGateOwners(source, sharedSettings) {
  if (!sharedSettings) {
    return [...source.matchAll(new RegExp(`(${IDENT})=${CALL}\\(([\`\"])782640499\\2\\)`, "g"))];
  }
  // The settings component imports the hidden-tab ID from the search module.
  const modules = [...source.matchAll(new RegExp(
    `[,{](${IDENT})\\(${IDENT},${IDENT},${IDENT}\\)\\{var [^;{}]+;let (${IDENT})="782640499",`, "g"))];
  if (modules.length !== 1) fail("expected exactly one settings gate declaration");
  const [declaration, id, binding] = modules[0];
  const start = modules[0].index + declaration.length;
  const owner = source.slice(start, start + 6000);
  const match = new RegExp(`\\.d\\(${IDENT},\\{\\},\\{(?:[^{}]*,)?(${IDENT}):${escapeRegex(binding)}(?=[,}])[^{}]*\\}\\)\\}`)
    .exec(owner);
  if (!match || !owner.slice(0, match.index).includes("settings.remoteConnections.tabs.accessOtherDevices")) {
    fail("settings gate export contract changed");
  }
  const imports = [...source.matchAll(new RegExp(`(${IDENT})=${IDENT}\\("${escapeRegex(id)}"\\)`, "g"))];
  if (imports.length !== 1) fail("expected exactly one settings gate import");
  return [...source.matchAll(new RegExp(`(${IDENT})=${CALL}\\(${escapeRegex(imports[0][1])}\\.${escapeRegex(match[1])}\\)`, "g"))];
}

function visibilityOwners(source) {
  return [...source.matchAll(/function [A-Za-z_$][\w$]*\(\{remoteControlConnectionsState:([A-Za-z_$][\w$]*),slingshotEnabled:([A-Za-z_$][\w$]*)\}\)\{([^{}]*)\}/g)];
}

function validateVisibility(source) {
  const owners = visibilityOwners(source);
  if (owners.length !== 1) fail("expected exactly one remote-control visibility function");
  const [, state, enabled, body] = owners[0];
  if (body !== `return ${enabled}&&(${state}?.available??!0)&&${state}?.accessRequired!==!0`) {
    fail("remote-control visibility contract changed");
  }
}

function patchSource(kind, source, { splitVisibility, splitBridge }) {
  if (kind === "main") {
    // Keep the wrapper's signedPayloadBase64 and canonical payload validation.
    if (!source.includes("Remote control device keys require resourcesPath") &&
        !source.includes("Device keys require resourcesPath")) {
      fail("device-key wrapper changed: resourcesPath guard");
    }
    for (const anchor of [
      "codex-device-key-sign-payload/v1",
      "Invalid remote-control device-key connection audience",
      "Invalid remote-control device-key enrollment audience",
      "this.getAddon().signDeviceKey(",
    ]) {
      if (!source.includes(anchor)) fail(`device-key wrapper changed: ${anchor}`);
    }
    // Vite uses template literals; rspack/SWC uses double-quoted strings.
    const nativeNames = [...source.matchAll(/([`"])remote-control-device-key\.node\1/g)];
    const softwareNames = [...source.matchAll(/([`"])flatpak-device-key\.cjs\1/g)];
    if (nativeNames.length === 0 && softwareNames.length === 1) return source;
    if (nativeNames.length !== 1 || softwareNames.length !== 0) {
      fail("expected exactly one native device-key filename");
    }
    const [before, quote] = nativeNames[0];
    return source.replace(before, padded(before, `${quote}flatpak-device-key.cjs${quote}`));
  }
  if (kind === "initial") {
    if (!splitBridge) {
      for (const anchor of [
        "[remote-connections/gate-bridge]",
        "set-remote-control-connections-enabled",
      ]) {
        if (!source.includes(anchor)) fail(`remote catalog contract changed: ${anchor}`);
      }
    }
    if (splitVisibility) {
      if (visibilityOwners(source).length) fail("ambiguous remote-control visibility layout");
    } else {
      validateVisibility(source);
    }
    source = gate(source, "4114442250", NAV_MARKER, 2);
    // Both the loader hook and the enablement bridge must agree; changing
    // visibility alone leaves the main process with an empty catalog.
    return gate(source, "1042620455", REMOTE_MARKER, splitBridge ? 1 : 2);
  }
  if (kind === "catalog") {
    // Only the shared navigation/loader owner: other copies of 1042620455
    // guard computer-use capabilities and must retain their upstream checks.
    source = gate(source, "4114442250", NAV_MARKER, 2);
    return gate(source, "1042620455", REMOTE_MARKER, 1);
  }
  if (kind === "sharedCatalog") return patchSharedCatalog(source);
  if (kind === "catalogState") return patchCatalogState(source);
  if (kind === "bridge") {
    // 26.1021 moved the bridge into app-runtime and replaced its IPC call
    // with a service method. Leave loading and one-to-one pairing unchanged.
    const marker = "[remote-connections/gate-bridge]";
    const index = source.indexOf(marker);
    const start = source.lastIndexOf("function ", index);
    const next = source.indexOf("function ", index);
    const end = next === -1 ? source.length : next;
    const owner = source.slice(start, end);
    if (source.split(marker).length !== 2 || start < 0 || owner.length > 6000 ||
        !/^function [A-Za-z_$][\w$]*\(\)\{/.test(owner) ||
        owner.split(".remoteConnections").length !== 2 ||
        owner.split(".setRemoteControlEnabled(").length !== 2 ||
        !new RegExp(`${IDENT}\\|\\|(?:(${IDENT})==null\\|\\|\\1|null==(${IDENT})\\|\\|\\2)` +
          `\\.setRemoteControlEnabled\\(\\{enabled:${IDENT},oneToOnePairingInAppEnabled:${IDENT}\\}\\)`).test(owner)) {
      fail("remote catalog service bridge contract changed");
    }
    return source.slice(0, start) + gate(owner, "1042620455", REMOTE_MARKER, 1) + source.slice(end);
  }
  if (kind === "visibility") {
    // 26.924.50649 extracted this function from app-initial. Validate its
    // backend availability/access checks without modifying any of its bytes.
    validateVisibility(source);
    return source;
  }
  if (splitVisibility && !source.includes(`from"./${splitVisibility}"`)) {
    fail("settings no longer imports the remote-control visibility bundle");
  }
  const owners = settingsGateOwners(source, kind === "sharedSettings");
  if (owners.length !== 1) fail("outbound tab gate owner changed");
  const owner = escapeRegex(owners[0][1]);
  const pattern = new RegExp(`(${IDENT}=)!(?:${owner}|0) *(?=,${IDENT}=(?:${IDENT}==null|null==${IDENT}))`, "g");
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

function readEntry(fd, { entry, path }, dataOffset) {
  const position = dataOffset + Number(entry.offset);
  if (entry.unpacked || entry.offset == null || !Number.isSafeInteger(position) ||
      position < dataOffset || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    fail(`unsupported entry: ${path}`);
  }
  return { original: read(fd, entry.size, position), position };
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function rspackTargets(fd, files, dataOffset) {
  const owners = { catalog: [], sharedCatalog: [], bridge: [], settings: [], sharedSettings: [], visibility: [] };
  const sharedCatalog = new RegExp(CATALOG_BINDINGS);
  for (const file of files.filter(file => /^webview\/assets\/async\/\d+\.[a-f\d]+\.js$/.test(file.path))) {
    const source = readEntry(fd, file, dataOffset).original.toString("utf8");
    if (sharedCatalog.test(source)) {
      owners.sharedCatalog.push(file);
    } else if (source.includes('"4114442250"') || source.includes(NAV_MARKER)) {
      owners.catalog.push(file);
    }
    if (source.includes("[remote-connections/gate-bridge]")) owners.bridge.push(file);
    if (source.includes('"782640499"')) owners.settings.push(file);
    if (source.includes("RemoteConnectionsSettings:")) owners.sharedSettings.push(file);
    if (/function [A-Za-z_$][\w$]*\(\{remoteControlConnectionsState:/.test(source)) owners.visibility.push(file);
  }
  const splitCatalog = owners.sharedCatalog.length > 0;
  const required = ["catalog", "bridge", splitCatalog ? "sharedSettings" : "settings"];
  for (const kind of required) {
    if (owners[kind].length !== 1) fail(`expected one rspack ${kind} bundle, found ${owners[kind].length}`);
  }
  if (owners.visibility.length === 0) fail("remote-control visibility bundles missing");
  const roles = [
    [splitCatalog ? "catalogState" : "catalog", owners.catalog],
    ["sharedCatalog", owners.sharedCatalog],
    ["bridge", owners.bridge],
    [splitCatalog ? "sharedSettings" : "settings", splitCatalog ? owners.sharedSettings : owners.settings],
    ["visibility", owners.visibility],
  ];
  if (!splitCatalog) {
    const paths = roles.flatMap(([, files]) => files.map(file => file.path));
    if (new Set(paths).size !== paths.length) fail("overlapping rspack remote-control owners");
  }
  return roles.flatMap(([kind, matches]) =>
    matches.map(file => [kind, { test: path => path === file.path }]));
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
      // 26.1027 replaced the Vite main bundle with rspack bootstrap chunks.
      // Resolve the one device-key owner, not a particular chunk number/hash.
      ["main", /^\.vite\/build\/(?:main-[^/]+|early-bootstrap(?:-[^/]+)?)\.js$/],
      ["initial", /^webview\/assets\/app-initial-[^/]+\.js$/],
      ["settings", /^webview\/assets\/remote-connections-settings-[^/]+\.js$/],
    ];
    const rspack = !files.some(file => targets[1][1].test(file.path)) &&
      files.some(file => /^webview\/assets\/async\/\d+\.[a-f\d]+\.js$/.test(file.path));
    let splitVisibility, splitBridge;
    if (rspack) {
      targets.splice(1, 2, ...rspackTargets(fd, files, dataOffset));
    } else {
      const visibilityPattern = /^webview\/assets\/remote-control-connections-visibility-[^/]+\.js$/;
      const visibility = files.filter(file => visibilityPattern.test(file.path));
      if (visibility.length > 1) fail("expected at most one remote-control visibility bundle");
      splitVisibility = visibility[0]?.path.split("/").at(-1);
      if (splitVisibility) targets.push(["visibility", visibilityPattern]);
      const bridgePattern = /^webview\/assets\/app-runtime-[^/]+\.js$/;
      const bridgeOwners = files.filter(file => targets[1][1].test(file.path) || bridgePattern.test(file.path))
        .filter(file => readEntry(fd, file, dataOffset).original.includes("[remote-connections/gate-bridge]"));
      if (bridgeOwners.length !== 1) fail("expected exactly one remote catalog bridge owner");
      splitBridge = bridgePattern.test(bridgeOwners[0].path);
      if (splitBridge) targets.push(["bridge", bridgePattern]);
    }
    const selected = new Map();
    for (const [kind, pattern] of targets) {
      let matches = files.filter(file => pattern.test(file.path));
      if (kind === "main") {
        matches = matches.filter(file =>
          /([`"])(?:remote-control-device-key\.node|flatpak-device-key\.cjs)\1/.test(
            readEntry(fd, file, dataOffset).original.toString("utf8")));
      }
      if (matches.length !== 1) fail(`expected one ${kind} bundle, found ${matches.length}`);
      const [file] = matches;
      if (!selected.has(file)) selected.set(file, []);
      selected.get(file).push(kind);
    }
    const writes = [];
    for (const [file, kinds] of selected) {
      const { entry, path } = file;
      const { original, position } = readEntry(fd, file, dataOffset);
      let source = original.toString("utf8");
      for (const kind of kinds) source = patchSource(kind, source, { splitVisibility, splitBridge });
      const contents = Buffer.from(source);
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
