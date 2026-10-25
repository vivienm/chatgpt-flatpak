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
const visibilityPath = "webview/assets/remote-control-connections-visibility-test.js";
const runtimePath = "webview/assets/app-runtime-test.js";
const visibilitySource = "function visible({remoteControlConnectionsState:e,slingshotEnabled:t})" +
  "{return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const legacyBridge = "function bridge(){const enabled=check(`1042620455`)||pairing;" +
  "return send(`set-remote-control-connections-enabled`,{enabled})}";
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
    legacyBridge +
    visibilitySource,
  [settingsPath]: "function settings(){let p=check(`782640499`),K=!p,de=v==null;return K}" +
    "function tabs(){let G=true,K=true,Re=G&&!0,ze=K&&(G||!1),Be=G&&!0,last;" +
    "return {showControlThisMacTab:Re,showControlOtherDevices:ze,showSsh:Be}}",
  "untouched.txt": "Do not modify unrelated bytes.",
};
const visibilityImport = 'import{visible}from"./remote-control-connections-visibility-test.js";';
const splitFixture = {
  ...fixture,
  [initialPath]: fixture[initialPath].replace(visibilitySource, ""),
  [settingsPath]: visibilityImport + fixture[settingsPath],
  [visibilityPath]: visibilitySource,
};
// 26.1021 moved the compiled enablement effect into app-runtime. Keep its
// loading guard, service call, pairing gate and dependency list observable.
const serviceBridge = "function bridge(){let e=cache(10),{checkGate:t,isLoading:n}=rollout(),r;" +
  "e[0]===t?r=e[1]:(r=t(pairingGate),e[0]=t,e[1]=r);let i=r,a;" +
  "e[2]!==t||e[3]!==i?(a=t(`1042620455`)||i,e[2]=t,e[3]=i,e[4]=a):a=e[4];" +
  "let o=a,s,c;return e[5]!==n||e[6]!==i||e[7]!==o?(s=()=>{let e=B.remoteConnections;" +
  "n||e==null||e.setRemoteControlEnabled({enabled:o,oneToOnePairingInAppEnabled:i})" +
  ".catch(e=>{log(`[remote-connections/gate-bridge] sync_failed`,e)})},c=[n,i,o]," +
  "e[5]=n,e[6]=i,e[7]=o,e[8]=s,e[9]=c):(s=e[8],c=e[9]),effect(s,c),null}";
const serviceFixture = {
  ...splitFixture,
  [initialPath]: splitFixture[initialPath].replace("const log='[remote-connections/gate-bridge]';", "")
    .replace(legacyBridge, ""),
  [runtimePath]: serviceBridge + "function unrelated(){return check(`1042620455`)}",
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

function testLayout(layout, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-patch-test-"));
  const archive = path.join(root, "app.asar");
  try {
    makeAsar(archive, sources);
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
    if (layout !== "inline") assert.deepEqual(after[visibilityPath], before[visibilityPath]);
    assert.ok(after[mainPath].text.includes("flatpak-device-key.cjs"));

    for (const patched of [false, true]) {
      const files = patched ? after : before;
      const context = vm.createContext({ get: () => false, check: () => false,
        flag: {}, pairing: false, send: (_method, params) => params.enabled, v: [] });
      context.cache = () => [];
      context.pairingGate = "pairing";
      context.rollout = () => ({ checkGate: id => id === "pairing" ? context.pairing : context.check(id), isLoading: context.loading });
      context.effect = fn => fn();
      context.B = { remoteConnections: { setRemoteControlEnabled: params => {
        context.bridgeResult = params;
        return { catch() {} };
      } } };
      vm.runInContext(files[initialPath].text + (files[visibilityPath]?.text ?? "") +
        (files[runtimePath]?.text ?? "") +
        files[settingsPath].text.replace(visibilityImport, ""), context);
      const calls = ["nav()", "list()", "load()"];
      if (layout !== "service") calls.push("bridge()");
      for (const call of calls) {
        assert.equal(vm.runInContext(call, context), patched, call);
      }
      if (layout === "service") {
        for (const pairing of [false, true]) {
          context.pairing = pairing;
          vm.runInContext("bridge()", context);
          assert.equal(context.bridgeResult.enabled, patched || pairing);
          assert.equal(context.bridgeResult.oneToOnePairingInAppEnabled, pairing);
        }
        context.bridgeResult = undefined;
        context.loading = true;
        vm.runInContext("bridge()", context);
        assert.equal(context.bridgeResult, undefined);
        context.loading = false;
        context.B.remoteConnections = null;
        vm.runInContext("bridge()", context);
        assert.equal(context.bridgeResult, undefined);
        assert.equal(vm.runInContext("unrelated()", context), false);
      }
      // A rollout hiding the outbound tab should no longer hide it.
      context.check = () => true;
      assert.equal(vm.runInContext("settings()", context), patched);
      assert.equal(vm.runInContext("tabs().showControlThisMacTab", context), !patched);
      assert.equal(vm.runInContext("tabs().showControlOtherDevices && tabs().showSsh", context), true);
      for (const [state, expected] of [
        [undefined, true],
        [{}, true],
        [{ available: true, accessRequired: false }, true],
        [{ available: false, accessRequired: false }, false],
        [{ available: true, accessRequired: true }, false],
      ]) {
        context.state = state;
        assert.equal(vm.runInContext("visible({remoteControlConnectionsState:state,slingshotEnabled:true})", context), expected);
        assert.equal(vm.runInContext("visible({remoteControlConnectionsState:state,slingshotEnabled:false})", context), false);
      }
    }
    const patched = fs.readFileSync(archive);
    assert.equal(run(archive).status, 0);
    assert.equal(run("--verify", archive).status, 0);
    assert.deepEqual(fs.readFileSync(archive), patched);

    const cases = [
      { ...sources, [settingsPath]: "upstream changed" },
      { ...sources, [initialPath]: sources[initialPath].replace("1042620455", "9999999999") },
      { ...sources, ".vite/build/main-duplicate.js": sources[mainPath] },
      { ...sources, [mainPath]: sources[mainPath].replace("connection audience", "changed audience") },
    ];
    for (const invalidSources of cases) {
      makeAsar(archive, invalidSources);
      const bytes = fs.readFileSync(archive);
      assert.notEqual(run(archive).status, 0);
      assert.deepEqual(fs.readFileSync(archive), bytes);
    }
    makeAsar(archive, sources, header => {
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
}

for (const [layout, sources] of [["inline", fixture], ["split", splitFixture], ["service", serviceFixture]]) {
  test(`ASAR patch (${layout} visibility): behavior, integrity, offsets, idempotence and fail-before-write`,
    () => testLayout(layout, sources));
}

test("service bridge drift, ambiguity and integrity errors fail before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-test-"));
  const archive = path.join(root, "app.asar");
  try {
    const { [runtimePath]: removed, ...missingBridge } = serviceFixture;
    const cases = [
      missingBridge,
      { ...serviceFixture, [initialPath]: splitFixture[initialPath] },
      { ...serviceFixture, "webview/assets/app-runtime-duplicate.js": removed },
      ...[
        ["setRemoteControlEnabled", "differentMethod"],
        ["oneToOnePairingInAppEnabled:i", "oneToOnePairingInAppEnabled:!0"],
        ["n||e==null||", "e==null||"],
        ["1042620455", "9999999999"],
        ["[remote-connections/gate-bridge]", "changed-marker"],
      ].map(([before, after]) => ({ ...serviceFixture, [runtimePath]: removed.replace(before, after) })),
    ];
    for (const sources of cases) {
      makeAsar(archive, sources);
      const original = fs.readFileSync(archive);
      for (const mode of [[], ["--check"], ["--verify"]]) {
        assert.notEqual(run(...mode, archive).status, 0);
        assert.deepEqual(fs.readFileSync(archive), original);
      }
    }
    makeAsar(archive, serviceFixture, header => {
      header.files.webview.files.assets.files["app-runtime-test.js"].integrity.hash = "0".repeat(64);
    });
    const original = fs.readFileSync(archive);
    assert.match(run(archive).stderr, /integrity mismatch/);
    assert.deepEqual(fs.readFileSync(archive), original);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("visibility drift or an ambiguous/missing bundle fails before any ASAR write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-visibility-test-"));
  const archive = path.join(root, "app.asar");
  try {
    for (const sources of [fixture, splitFixture]) {
      const ownerPath = sources === fixture ? initialPath : visibilityPath;
      for (const [before, after] of [
        ["?.available??!0", "?.available??!1"],
        ["?.accessRequired!==!0", "?.accessRequired===!0"],
        ["return t&&", "return !0&&"],
        [visibilitySource, visibilitySource + visibilitySource],
        [visibilitySource, ""],
      ]) {
        makeAsar(archive, { ...sources, [ownerPath]: sources[ownerPath].replace(before, after) });
        const original = fs.readFileSync(archive);
        for (const mode of [[], ["--check"], ["--verify"]]) {
          assert.notEqual(run(...mode, archive).status, 0, `${ownerPath}: ${before}`);
          assert.deepEqual(fs.readFileSync(archive), original);
        }
      }
    }
    const { [visibilityPath]: removed, ...missingVisibility } = splitFixture;
    const cases = [
      missingVisibility,
      { ...splitFixture, [initialPath]: fixture[initialPath] },
      { ...splitFixture, [settingsPath]: fixture[settingsPath] },
      { ...splitFixture, "webview/assets/remote-control-connections-visibility-duplicate.js": removed },
    ];
    for (const sources of cases) {
      makeAsar(archive, sources);
      const original = fs.readFileSync(archive);
      assert.notEqual(run(archive).status, 0);
      assert.deepEqual(fs.readFileSync(archive), original);
    }
    makeAsar(archive, splitFixture, header => {
      header.files.webview.files.assets.files[visibilityPath.split("/").at(-1)].integrity.hash = "0".repeat(64);
    });
    const original = fs.readFileSync(archive);
    assert.match(run(archive).stderr, /integrity mismatch/);
    assert.deepEqual(fs.readFileSync(archive), original);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
