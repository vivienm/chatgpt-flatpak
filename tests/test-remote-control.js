"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const patcher = path.resolve(__dirname, "../build-aux/patch-remote-control.js");
const mainPath = ".vite/build/main-test.js";
const initialPath = "webview/assets/app-initial-test.js";
const settingsPath = "webview/assets/remote-connections-settings-test.js";
const fixture = {
  [mainPath]: "const text='café 中文 😀';const addon=`remote-control-device-key.node`;" +
    "const notes=['Remote control device keys require resourcesPath'," +
    "'codex-device-key-sign-payload/v1'," +
    "'Invalid remote-control device-key connection audience'," +
    "'Invalid remote-control device-key enrollment audience'];" +
    "function sign(e,n){return this.getAddon().signDeviceKey(e,n)}",
  [initialPath]: "const log='[remote-connections/gate-bridge]';" +
    "function nav(){return get(flag,`4114442250`)}" +
    "function list(){return get(flag,`4114442250`)}" +
    "function load(){return check(`1042620455`)}" +
    "function bridge(){const enabled=check(`1042620455`)||pairing;" +
    "return send(`set-remote-control-connections-enabled`,{enabled})}" +
    "function visible({remoteControlConnectionsState:e,slingshotEnabled:t})" +
    "{return t&&(e?.available??!0)&&e?.accessRequired!==!0}",
  [settingsPath]: "function settings(){let p=check(`782640499`),K=!p,de=v==null;return K}" +
    "function tabs(){let G=true,K=true,Re=G&&!0,ze=K&&(G||!1),Be=G&&!0,last;" +
    "return {showControlThisMacTab:Re,showControlOtherDevices:ze,showSsh:Be}}",
  "untouched.txt": "Do not modify unrelated bytes.",
};

function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function makeAsar(filename, sources = fixture, mutateHeader = () => {}) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, source] of Object.entries(sources)) {
    const bytes = Buffer.from(source);
    let parent = header;
    const segments = name.split("/");
    for (const part of segments.slice(0, -1)) parent = parent.files[part] ||= { files: {} };
    const blocks = [];
    for (let i = 0; i < bytes.length; i += 64) blocks.push(hash(bytes.subarray(i, i + 64)));
    parent.files[segments.at(-1)] = {
      size: bytes.length, offset: String(offset),
      integrity: { algorithm: "SHA256", blockSize: 64, hash: hash(bytes), blocks },
    };
    chunks.push(bytes);
    offset += bytes.length;
  }
  mutateHeader(header);
  const json = Buffer.from(JSON.stringify(header));
  const padded = (json.length + 3) & ~3;
  const prelude = Buffer.alloc(16 + padded);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(8 + padded, 4);
  prelude.writeUInt32LE(4 + padded, 8);
  prelude.writeUInt32LE(json.length, 12);
  json.copy(prelude, 16);
  fs.writeFileSync(filename, Buffer.concat([prelude, ...chunks]));
}

function readAsar(filename) {
  const bytes = fs.readFileSync(filename);
  const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)));
  const start = 8 + bytes.readUInt32LE(4);
  const files = {};
  function walk(node, prefix = "") {
    for (const [name, entry] of Object.entries(node.files)) {
      const filename = prefix + name;
      if (entry.files) walk(entry, filename + "/");
      else {
        const data = bytes.subarray(start + Number(entry.offset), start + Number(entry.offset) + entry.size);
        assert.equal(entry.integrity.hash, hash(data));
        const blocks = [];
        for (let i = 0; i < data.length; i += 64) blocks.push(hash(data.subarray(i, i + 64)));
        assert.deepEqual(entry.integrity.blocks, blocks);
        files[filename] = { text: data.toString(), offset: entry.offset, size: entry.size };
      }
    }
  }
  walk(header);
  return files;
}

function run(...args) { return spawnSync(process.execPath, [patcher, ...args], { encoding: "utf8" }); }

test("ASAR patch: behavior, integrity, offsets, idempotence and fail-before-write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-patch-test-"));
  const archive = path.join(root, "app.asar");
  try {
    makeAsar(archive);
    const original = fs.readFileSync(archive);
    assert.equal(run("--check", archive).status, 0);
    assert.notEqual(run("--verify", archive).status, 0);
    assert.deepEqual(fs.readFileSync(archive), original);
    const before = readAsar(archive);
    const result = run(archive);
    assert.equal(result.status, 0, result.stderr);
    const after = readAsar(archive);
    assert.equal(fs.statSync(archive).size, original.length);
    for (const name of Object.keys(before)) {
      assert.equal(after[name].offset, before[name].offset);
      assert.equal(after[name].size, before[name].size);
    }
    assert.deepEqual(after["untouched.txt"], before["untouched.txt"]);
    assert.ok(after[mainPath].text.includes("flatpak-device-key.cjs"));

    for (const patched of [false, true]) {
      const files = patched ? after : before;
      const context = vm.createContext({ get: () => false, check: () => false,
        flag: {}, pairing: false, send: (_method, params) => params.enabled, v: [] });
      vm.runInContext(files[initialPath].text + files[settingsPath].text, context);
      assert.equal(vm.runInContext("nav() && list() && load() && bridge()", context), patched);
      // A rollout hiding the outbound tab should no longer hide it.
      context.check = () => true;
      assert.equal(vm.runInContext("settings()", context), patched);
      assert.equal(vm.runInContext("tabs().showControlThisMacTab", context), !patched);
      assert.equal(vm.runInContext("tabs().showControlOtherDevices && tabs().showSsh", context), true);
      for (const [state, expected] of [
        [{ available: true, accessRequired: false }, true],
        [{ available: false, accessRequired: false }, false],
        [{ available: true, accessRequired: true }, false],
      ]) {
        context.state = state;
        assert.equal(vm.runInContext("visible({remoteControlConnectionsState:state,slingshotEnabled:true})", context), expected);
      }
    }
    const patched = fs.readFileSync(archive);
    assert.equal(run(archive).status, 0);
    assert.equal(run("--verify", archive).status, 0);
    assert.deepEqual(fs.readFileSync(archive), patched);

    const cases = [
      { ...fixture, [settingsPath]: "upstream changed" },
      { ...fixture, [initialPath]: fixture[initialPath].replace("1042620455", "9999999999") },
      { ...fixture, ".vite/build/main-duplicate.js": fixture[mainPath] },
      { ...fixture, [mainPath]: fixture[mainPath].replace("connection audience", "changed audience") },
    ];
    for (const sources of cases) {
      makeAsar(archive, sources);
      const bytes = fs.readFileSync(archive);
      assert.notEqual(run(archive).status, 0);
      assert.deepEqual(fs.readFileSync(archive), bytes);
    }
    makeAsar(archive, fixture, header => {
      header.files.webview.files.assets.files["remote-connections-settings-test.js"].integrity.hash = "0".repeat(64);
    });
    const invalid = fs.readFileSync(archive);
    assert.match(run(archive).stderr, /integrity mismatch/);
    assert.deepEqual(fs.readFileSync(archive), invalid);
    fs.writeFileSync(archive, original.subarray(0, 15));
    assert.match(run(archive).stderr, /truncated ASAR/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
