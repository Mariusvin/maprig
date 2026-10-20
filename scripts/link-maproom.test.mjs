import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("project registration is additive, repeatable and refuses ID collisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maproom-link-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const project = path.join(root, "project");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(project, ".maproom"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "workspace.yaml"), "# retain this comment\nprojects:\n  - id: default\n    root: .\n");
    const source = path.join(project, ".maproom", "project.json");
    const bytes = JSON.stringify({ version: 1, project: { id: "example", name: "Example", rootGraphId: "root", graphs: [{ id: "root", level: 1, title: "Root", nodes: [] }] } });
    fs.writeFileSync(source, bytes);
    const run = () => spawnSync(process.execPath, ["scripts/link-maproom.mjs", "--project-root", project, "--workspace", workspace], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).changed, true);
    const registered = fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8");
    assert.match(registered, /retain this comment/);
    assert.match(registered, /id: default/);
    assert.match(registered, /id: example/);
    assert.equal(JSON.parse(run().stdout).changed, false);
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"), registered);
    assert.equal(fs.readFileSync(source, "utf8"), bytes);
    fs.writeFileSync(path.join(workspace, "workspace.yaml"), "projects:\n  - id: example\n    root: somewhere-else\n");
    const before = fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8");
    const conflict = run();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /conflict/);
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maproom-link-guard-test-"));
  const project = path.join(root, "project");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(project, ".maproom"), { recursive: true });
  fs.mkdirSync(workspace);
  const source = path.join(project, ".maproom", "project.json");
  fs.writeFileSync(source, JSON.stringify({ version: 1, project: { id: "example", name: "Example", rootGraphId: "root", graphs: [{ id: "root", level: 1, title: "Root", nodes: [] }] } }));
  const catalog = path.join(workspace, "workspace.yaml");
  fs.writeFileSync(catalog, "projects: []\n");
  const args = ["scripts/link-maproom.mjs", "--project-root", project, "--workspace", workspace];
  const run = () => spawnSync(process.execPath, args, { encoding: "utf8" });
  return { root, project, workspace, source, catalog, args, run };
}

test("source symlinks are rejected before catalog registration", { skip: process.platform === "win32" }, () => {
  const f = setup();
  try {
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.renameSync(f.source, path.join(outside, "project.json"));
    fs.rmdirSync(path.dirname(f.source));
    fs.symlinkSync(outside, path.dirname(f.source), "dir");
    const directoryLink = f.run();
    assert.equal(directoryLink.status, 1);
    assert.match(directoryLink.stderr, /outside selected project/);
    assert.equal(fs.readFileSync(f.catalog, "utf8"), "projects: []\n");
    fs.unlinkSync(path.dirname(f.source));
    fs.mkdirSync(path.dirname(f.source));
    fs.symlinkSync(path.join(outside, "project.json"), f.source);
    const fileLink = f.run();
    assert.equal(fileLink.status, 1);
    assert.match(fileLink.stderr, /outside selected project/);
    assert.equal(fs.readFileSync(f.catalog, "utf8"), "projects: []\n");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a concurrent registration lock prevents catalog writes", () => {
  const f = setup();
  try {
    const lock = path.join(f.workspace, ".openrig-maproom-link.lock");
    fs.writeFileSync(lock, "held by other process");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /catalog lock/);
    assert.equal(fs.readFileSync(f.catalog, "utf8"), "projects: []\n");
    assert.equal(fs.readFileSync(lock, "utf8"), "held by other process");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an intervening external edit survives aborted registration", () => {
  const f = setup();
  try {
    const otherEdit = "# edited by another writer\nprojects:\n  - id: other\n    root: other\n";
    // Inject an external edit after preparing the replacement, before committing it.
    const inject = `import fs from 'node:fs'; const original=fs.writeFileSync; fs.writeFileSync=function(target,...args) { const result=original.call(fs,target,...args); if(typeof target==='string' && target.endsWith('.tmp')) original.call(fs,${JSON.stringify(f.catalog)},${JSON.stringify(otherEdit)}); return result; }; process.argv=${JSON.stringify([process.execPath, ...f.args])}; await import('./scripts/link-maproom.mjs');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", inject], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed during registration/);
    assert.equal(fs.readFileSync(f.catalog, "utf8"), otherEdit);
    assert.equal(fs.existsSync(path.join(f.workspace, ".openrig-maproom-link.lock")), false);
    assert.equal(fs.readdirSync(f.workspace).some(name => name.endsWith(".tmp")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
