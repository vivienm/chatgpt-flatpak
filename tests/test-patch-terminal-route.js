#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const patcher = path.join(repo, "build-aux", "patch-terminal-route.js");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-route-test-"));

const clientCase = "case`client-local-thread`:";
const vulnerableTail =
  "case`new-thread-panel`:case`chatgpt-thread`:case`client-local-thread`:" +
  "case`remote-thread`:case`other`:return null";
const source = Buffer.from(
  "const i18n=`caf\u00e9 \u4e2d\u6587 \ud83d\ude00`;" +
    "function route(e){switch(e.value.routeKind){case`home`:{let t=e.get(cwd),n=e.get(host);" +
    "return{conversationId:e.value.clientThreadId,conversationTitle:null,cwd:t,hostId:n}}" +
    "case`local-thread`:return{conversationId:e.value.conversationId,conversationTitle:null," +
    `cwd:e.get(cwd),hostId:e.get(host)};${vulnerableTail}}}`,
);

function sourceWithPrefix(resolverPrefix) {
  return Buffer.from(
    source
      .toString()
      .replace("function route(e){switch(e.value.routeKind){", resolverPrefix),
  );
}

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeAsar(asarPath, contents) {
  const sources = Buffer.isBuffer(contents) ? { "webview/assets/app-initial-test.js": contents } : contents;
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(sources)) {
    const blockSize = 64;
    const integrity = {
      algorithm: "SHA256",
      blockSize,
      blocks: [],
      hash: hash(contents),
    };
    for (let offset = 0; offset < contents.length; offset += blockSize) {
      integrity.blocks.push(hash(contents.subarray(offset, offset + blockSize)));
    }
    let parent = header;
    const parts = name.split("/");
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ||= { files: {} };
    parent.files[parts.at(-1)] = { integrity, offset: String(offset), size: contents.length };
    chunks.push(contents);
    offset += contents.length;
  }
  const headerBytes = Buffer.from(JSON.stringify(header));
  const alignedHeaderSize = (headerBytes.length + 3) & ~3;
  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(8 + alignedHeaderSize, 4);
  prelude.writeUInt32LE(4 + headerBytes.length, 8);
  prelude.writeUInt32LE(headerBytes.length, 12);
  const dataOffset = 16 + alignedHeaderSize;
  const archive = Buffer.alloc(dataOffset + offset);
  prelude.copy(archive, 0);
  headerBytes.copy(archive, 16);
  Buffer.concat(chunks).copy(archive, dataOffset);
  fs.writeFileSync(asarPath, archive);
}

function readAsar(asarPath) {
  const archive = fs.readFileSync(asarPath);
  const headerSize = archive.readUInt32LE(12);
  const header = JSON.parse(archive.subarray(16, 16 + headerSize).toString());
  const entry = header.files.webview.files.assets.files["app-initial-test.js"];
  const dataOffset = 8 + archive.readUInt32LE(4);
  const contents = archive.subarray(dataOffset, dataOffset + entry.size);
  return { contents, entry };
}

function run(...args) {
  return spawnSync(process.execPath, [patcher, ...args], { encoding: "utf8" });
}

try {
  const asarPath = path.join(work, "app.asar");
  makeAsar(asarPath, source);

  let result = run("--check", asarPath);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /would patch/);
  assert.ok(readAsar(asarPath).contents.includes(Buffer.from(vulnerableTail)));

  result = run(asarPath);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched/);

  const patched = readAsar(asarPath);
  const patchedText = patched.contents.toString();
  const expectedText = source
    .toString()
    .replace("case`home`:", `${clientCase}case\`home\`:`)
    .replace(vulnerableTail, vulnerableTail.replace(clientCase, ""));
  assert.strictEqual(patched.contents.length, source.length);
  assert.strictEqual(patchedText, expectedText);
  assert.strictEqual(patched.entry.integrity.hash, hash(patched.contents));
  assert.deepStrictEqual(
    patched.entry.integrity.blocks,
    Array.from(
      { length: Math.ceil(patched.contents.length / patched.entry.integrity.blockSize) },
      (_, index) =>
        hash(
          patched.contents.subarray(
            index * patched.entry.integrity.blockSize,
            (index + 1) * patched.entry.integrity.blockSize,
          ),
        ),
    ),
  );

  result = run(asarPath);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /already patched/);

  const guardedPath = path.join(work, "guarded.asar");
  makeAsar(
    guardedPath,
    sourceWithPrefix(
      "function W(e){if(e.get(_))return null;switch(e.value.routeKind){",
    ),
  );
  result = run("--check", guardedPath);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /would patch/);

  for (const [name, resolverPrefix] of [
    [
      "wrong-guard-parameter",
      "function W(e){if(t.get(_))return null;switch(e.value.routeKind){",
    ],
    [
      "wrong-switch-parameter",
      "function W(e){if(e.get(_))return null;switch(t.value.routeKind){",
    ],
  ]) {
    const unexpectedShapePath = path.join(work, `${name}.asar`);
    makeAsar(unexpectedShapePath, sourceWithPrefix(resolverPrefix));
    result = run("--check", unexpectedShapePath);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /terminal resolver shape changed/);
  }

  const unsupportedPath = path.join(work, "unsupported.asar");
  makeAsar(unsupportedPath, Buffer.from("console.log('upstream changed')"));
  result = run(unsupportedPath);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /review the upstream bundle/);

  // SWC quotes, imported guard and duplicated modules from 26.1029.
  const chunkedPath = path.join(work, "chunked.asar");
  const first = "webview/assets/async/222844.6f36d28554.js";
  const second = "webview/assets/async/317059.094621bd56.js";
  const rspack = Buffer.from(sourceWithPrefix(
    "function route(e){if(e.get(guard.flag))return null;switch(e.value.routeKind){",
  ).toString().replaceAll("`", '"'));
  const chunks = { [first]: rspack, [second]: Buffer.from(rspack.toString().replace("function route(", "function other(")) };
  makeAsar(chunkedPath, chunks);
  const original = fs.readFileSync(chunkedPath);
  assert.strictEqual(run("--check", chunkedPath).status, 0);
  assert.deepStrictEqual(fs.readFileSync(chunkedPath), original);
  result = run(chunkedPath);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched 2 bundles/);
  const patchedArchive = fs.readFileSync(chunkedPath);
  const dataOffset = 8 + patchedArchive.readUInt32LE(4);
  const header = JSON.parse(patchedArchive.subarray(16, 16 + patchedArchive.readUInt32LE(12)));
  for (const [name, before] of Object.entries(chunks)) {
    let entry = header;
    for (const part of name.split("/")) entry = entry.files[part];
    assert.strictEqual(entry.size, before.length);
    const after = patchedArchive.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + entry.size);
    assert.strictEqual(entry.integrity.hash, hash(after));
    assert.deepStrictEqual(entry.integrity.blocks, Array.from({ length: Math.ceil(after.length / 64) },
      (_, i) => hash(after.subarray(i * 64, (i + 1) * 64))));
    const context = vm.createContext({ cwd: "cwd", host: "host", guard: { flag: "guard" } });
    vm.runInContext(after.toString(), context);
    const resolve = context[name === first ? "route" : "other"];
    for (const routeKind of ["home", "client-local-thread", "local-thread", "remote-thread", "other"]) {
      const value = { routeKind, clientThreadId: "client", conversationId: "conversation" };
      const target = resolve({ value, get: key => ({ cwd: "/work", host: "local", guard: false })[key] });
      if (["remote-thread", "other"].includes(routeKind)) assert.strictEqual(target, null);
      else assert.deepStrictEqual(JSON.parse(JSON.stringify(target)), {
        conversationId: routeKind === "local-thread" ? "conversation" : "client",
        conversationTitle: null, cwd: "/work", hostId: "local",
      });
      assert.strictEqual(resolve({ value, get: () => true }), null);
    }
  }
  assert.strictEqual(patchedArchive.length, original.length);
  assert.strictEqual(run(chunkedPath).status, 0);
  assert.deepStrictEqual(fs.readFileSync(chunkedPath), patchedArchive);

  for (const broken of [
    Buffer.from(chunks[second].toString().replace('case"other":return null', 'case"other":return void 0')),
    Buffer.from(chunks[second].toString().replace("e.get(guard.flag)", "t.get(guard.flag)")),
    Buffer.from(chunks[second].toString().replace('case"home":', 'case"client-local-thread":case"home":')
      .replace('case"chatgpt-thread":case"client-local-thread":', 'case"chatgpt-thread":')),
  ]) {
    makeAsar(chunkedPath, { ...chunks, [second]: broken });
    const bytes = fs.readFileSync(chunkedPath);
    assert.notStrictEqual(run(chunkedPath).status, 0);
    assert.deepStrictEqual(fs.readFileSync(chunkedPath), bytes);
  }
  makeAsar(chunkedPath, { [first]: Buffer.concat([rspack, source]) });
  const ambiguous = fs.readFileSync(chunkedPath);
  assert.notStrictEqual(run(chunkedPath).status, 0);
  assert.deepStrictEqual(fs.readFileSync(chunkedPath), ambiguous);
  makeAsar(chunkedPath, chunks);
  const corrupt = fs.readFileSync(chunkedPath);
  corrupt[corrupt.length - 1] ^= 1;
  fs.writeFileSync(chunkedPath, corrupt);
  assert.match(run(chunkedPath).stderr, /integrity mismatch/);
  assert.deepStrictEqual(fs.readFileSync(chunkedPath), corrupt);

  console.log("patch-terminal-route: legacy and rspack behavior, integrity, idempotence and drift checks passed");
} finally {
  fs.rmSync(work, { force: true, recursive: true });
}
