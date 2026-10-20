#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { parsePlanningProject } from "../packages/daemon/dist/domain/workspace/planning-graph.js";
import { insideProject } from "../packages/daemon/dist/domain/workspace/project-read.js";

// Register a native directory or a read-only directory mount. Never copy project content.
const args = process.argv.slice(2);
function option(name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
let lock;
let lockPath;
try {
  const source = option("--project-root");
  const workspace = option("--workspace");
  if (!source || !workspace || args.length !== 4) throw new Error("Usage: node scripts/link-maproom.mjs --project-root <directory> --workspace <workspace-directory>");
  const projectRoot = fs.realpathSync(source);
  const workspaceRoot = fs.realpathSync(workspace);
  const sourcePath = insideProject(projectRoot, path.join(projectRoot, ".maproom", "project.json"));
  if (fs.statSync(sourcePath).size > 20 * 1024 * 1024) throw new Error("Planning source exceeds 20 MiB");
  const envelope = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const project = parsePlanningProject(envelope, envelope?.project?.id);
  const catalog = path.join(workspaceRoot, "workspace.yaml");
  lockPath = path.join(workspaceRoot, ".openrig-maproom-link.lock");
  try { lock = fs.openSync(lockPath, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Another Maproom registration holds the catalog lock; retry after it finishes"); throw error; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const original = fs.existsSync(catalog) ? fs.readFileSync(catalog, "utf8") : "schema: openrig.workspace/v0alpha1\nprojects: []\n";
  const document = parseDocument(original);
  if (document.errors.length) throw document.errors[0];
  const entries = document.toJS()?.projects;
  if (!Array.isArray(entries)) throw new Error("Workspace catalog projects must be a list");
  const matchingId = entries.filter(p => p.id === project.id);
  const rootOf = entry => path.resolve(workspaceRoot, entry.root);
  if (matchingId.length > 1 || matchingId.some(p => rootOf(p) !== projectRoot) || entries.some(p => rootOf(p) === projectRoot && p.id !== project.id)) {
    throw new Error("Catalog identity conflict; no files changed");
  }
  if (!matchingId.length) {
    document.addIn(["projects"], { id: project.id, root: path.relative(workspaceRoot, projectRoot).split(path.sep).join("/") || "." });
    const temporary = `${catalog}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, String(document), { flag: "wx" });
      const current = fs.existsSync(catalog) ? fs.readFileSync(catalog, "utf8") : "schema: openrig.workspace/v0alpha1\nprojects: []\n";
      if (current !== original) throw new Error("Workspace catalog changed during registration; no changes applied, retry with the current catalog");
      fs.renameSync(temporary, catalog);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  console.log(JSON.stringify({ id: project.id, name: project.name, graphs: project.graphs.length,
    nodes: project.graphs.reduce((total, g) => total + g.nodes.length, 0), catalog, mode: "linked-read-only", changed: !matchingId.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
