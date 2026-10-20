import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

test("batch registration validates every plan, preserves the catalog and repeats without duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-registration-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const mount = path.join(root, "copies");
    const project = path.join(mount, "demo");
    fs.mkdirSync(workspace);
    fs.mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    const plan = { version: 1, project: { id: "demo", name: "Demo", rootGraphId: "root", graphs: [{ id: "root", level: 1, title: "Root", nodes: [] }] } };
    fs.writeFileSync(path.join(project, "planning.json"), JSON.stringify(plan));
    fs.writeFileSync(path.join(workspace, "workspace.yaml"), "# existing context\nprojects:\n  - id: default\n    root: .\n");
    const report = path.join(root, "report.json");
    fs.writeFileSync(report, JSON.stringify({ destination: "C:/copies", errors: [], copied: [{ id: "demo", destination: "C:/copies/demo" }] }));
    const run = () => spawnSync(process.execPath, ["scripts/register-project-copies.mjs", "--report", report, "--workspace", workspace, "--mount-root", mount],
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "gitconfig") } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).registered, 1);
    const catalog = fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8");
    assert.match(catalog, /existing context/);
    assert.match(catalog, /id: default/);
    assert.match(catalog, /id: demo/);
    assert.equal(JSON.parse(run().stdout).changed, 0);
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"), catalog);
    const invalid = { ...plan, project: { ...plan.project, id: "other" } };
    fs.writeFileSync(path.join(project, "planning.json"), JSON.stringify(invalid));
    assert.equal(run().status, 1);
    assert.equal(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"), catalog);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
