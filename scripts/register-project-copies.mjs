#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";
import { readPlanningProject } from "../packages/daemon/dist/domain/workspace/planning-graph.js";

const args = process.argv.slice(2);
const option = key => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
let lock;
let lockPath;
try {
  const reportPath = option("--report");
  const workspacePath = option("--workspace");
  const mountPath = option("--mount-root");
  if (!reportPath || !workspacePath || !mountPath) throw new Error("Usage: --report <copy-report.json> --workspace <workspace> --mount-root <mounted-copy-directory>");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.errors?.length) throw new Error("Copy report still contains unresolved errors");
  const workspace = fs.realpathSync(workspacePath);
  const mount = fs.realpathSync(mountPath);
  const originPrefix = report.destination.replaceAll("\\", "/").replace(/\/$/, "");
  const seen = new Set();
  const projects = report.copied.map(copy => {
    if (seen.has(copy.id)) throw new Error(`Duplicate project ID: ${copy.id}`);
    seen.add(copy.id);
    const destination = copy.destination.replaceAll("\\", "/");
    if (!destination.toLowerCase().startsWith(`${originPrefix.toLowerCase()}/`)) throw new Error("Copy root is outside the reported destination");
    const rel = destination.slice(originPrefix.length + 1);
    const root = fs.realpathSync(path.join(mount, rel));
    const relative = path.relative(mount, root);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Copy root escapes the mounted directory");
    const result = readPlanningProject({ root, id: copy.id });
    if (!fs.existsSync(path.join(root, ".git"))) throw new Error(`Copied project lacks its independent Git repository: ${copy.id}`);
    return { id: copy.id, root, name: result.project.name, graphs: result.project.graphs.length, nodes: result.project.graphs.reduce((sum, g) => sum + g.nodes.length, 0), kind: result.source.kind };
  });
  const catalog = path.join(workspace, "workspace.yaml");
  const target = fs.existsSync(catalog) ? fs.realpathSync(catalog) : catalog;
  lockPath = path.join(path.dirname(target), ".openrig-maproom-link.lock");
  lock = fs.openSync(lockPath, "wx");
  const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "schema: openrig.workspace/v0alpha1\nprojects: []\n";
  const document = parseDocument(original);
  if (document.errors.length) throw document.errors[0];
  const entries = document.toJS()?.projects;
  if (!Array.isArray(entries)) throw new Error("Invalid workspace project catalog");
  let changed = 0;
  for (const project of projects) {
    const existing = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.id === project.id);
    if (existing.length > 1) throw new Error(`Ambiguous catalog ID ${project.id}`);
    const rootValue = path.relative(workspace, project.root).split(path.sep).join("/") || ".";
    if (!existing.length) {
      document.addIn(["projects"], { id: project.id, root: rootValue });
      changed++;
      continue;
    }
    const { entry, index } = existing[0];
    const oldRoot = fs.realpathSync(path.resolve(workspace, entry.root));
    if (oldRoot === project.root) continue;
    const replacement = report.replacements?.find(item => item.id === project.id && fs.realpathSync(item.fromRoot) === oldRoot);
    if (!replacement) throw new Error(`Existing project ${project.id} points elsewhere; explicit replacement provenance is required`);
    const before = readPlanningProject({ id: project.id, root: oldRoot }).project;
    const after = readPlanningProject(project).project;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Replacement would change the existing authored plan for ${project.id}`);
    document.setIn(["projects", index, "root"], rootValue);
    changed++;
  }
  const next = String(document);
  if (next !== original) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, next, { flag: "wx" });
      if ((fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "schema: openrig.workspace/v0alpha1\nprojects: []\n") !== original) throw new Error("Catalog changed during registration");
      if (fs.existsSync(target)) fs.chmodSync(temporary, fs.statSync(target).mode & 0o7777);
      fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  // Protected Git configuration trusts only the exact, explicitly registered copies.
  let configuredRoots = "";
  try { configuredRoots = execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) { if (error.status !== 1) throw error; }
  const safeRoots = new Set(configuredRoots.split(/\r?\n/).filter(Boolean));
  for (const project of projects) if (!safeRoots.has(project.root)) {
    execFileSync("git", ["config", "--global", "--add", "safe.directory", project.root], { stdio: "pipe" });
  }
  console.log(JSON.stringify({ registered: projects.length, changed, projects }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
