#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { parsePlanningProject } from "../packages/daemon/dist/domain/workspace/planning-graph.js";

// Register a native directory or a read-only directory mount. Never copy project content.
const args = process.argv.slice(2);
function option(name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
try {
  const source = option("--project-root");
  const workspace = option("--workspace");
  if (!source || !workspace || args.length !== 4) throw new Error("Usage: node scripts/link-maproom.mjs --project-root <directory> --workspace <workspace-directory>");
  const projectRoot = fs.realpathSync(source);
  const workspaceRoot = fs.realpathSync(workspace);
  const envelope = JSON.parse(fs.readFileSync(path.join(projectRoot, ".maproom", "project.json"), "utf8"));
  const project = parsePlanningProject(envelope, envelope?.project?.id);
  const catalog = path.join(workspaceRoot, "workspace.yaml");
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
      fs.renameSync(temporary, catalog);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  console.log(JSON.stringify({ id: project.id, name: project.name, graphs: project.graphs.length,
    nodes: project.graphs.reduce((total, g) => total + g.nodes.length, 0), catalog, mode: "linked-read-only", changed: !matchingId.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
