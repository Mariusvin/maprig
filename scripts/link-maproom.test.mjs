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
