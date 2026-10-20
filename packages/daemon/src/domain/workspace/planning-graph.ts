import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { insideProject, type ProjectRead } from "./project-read.js";

export interface PlanningNode {
  id: string;
  title: string;
  summary?: string;
  status: string;
  progress: number;
  position: { x: number; y: number };
  dependsOn: string[];
  childGraphId?: string;
  conclusion?: string;
  references?: unknown[];
  [key: string]: unknown;
}
export interface PlanningGraph {
  id: string;
  level: number;
  title: string;
  parentNodeId?: string;
  nodes: PlanningNode[];
}
export interface PlanningProject {
  id: string;
  name: string;
  summary?: string;
  rootGraphId: string;
  graphs: PlanningGraph[];
  updatedAt?: string;
}
export type PlanningSourceKind = "maproom" | "openrig";
export interface PlanningSourceFile { filename: string; kind: PlanningSourceKind }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate identities and links without changing authored state or recomputing progress. */
export function parsePlanningProject(value: unknown, expectedId: string): PlanningProject {
  const fail = (message: string): never => { throw new Error(`Invalid planning source: ${message}`); };
  if (!object(value) || value.version !== 1 || !object(value.project)) return fail("expected version 1 project envelope");
  const p = value.project;
  if (p.id !== expectedId || !id(p.id) || !text(p.name) || !id(p.rootGraphId) || !Array.isArray(p.graphs) || p.graphs.length > 1000 ||
    (p.summary !== undefined && !text(p.summary)) || (p.updatedAt !== undefined && !text(p.updatedAt))) return fail("project identity or graphs");
  const graphIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const g of p.graphs) {
    if (!object(g) || !id(g.id) || graphIds.has(g.id) || !Number.isInteger(g.level) || (g.level as number) < 1 || !text(g.title) || !Array.isArray(g.nodes)) return fail("graph identity or shape");
    graphIds.add(g.id);
    const localIds = new Set<string>();
    for (const n of g.nodes) {
      if (!object(n) || !id(n.id) || nodeIds.has(n.id) || !text(n.title) ||
        !["planned", "ready", "in_progress", "blocked", "done"].includes(n.status as string) ||
        !finite(n.progress) || n.progress < 0 || n.progress > 100 || !object(n.position) || !finite(n.position.x) || !finite(n.position.y) ||
        !Array.isArray(n.dependsOn) || !n.dependsOn.every(id) || (n.childGraphId !== undefined && !id(n.childGraphId)) ||
        (n.summary !== undefined && !text(n.summary)) || (n.conclusion !== undefined && !text(n.conclusion)) ||
        (n.references !== undefined && (!Array.isArray(n.references) || !n.references.every(r => object(r) &&
          (r.id === undefined || text(r.id)) && (r.title === undefined || text(r.title)) && (r.url === undefined || text(r.url)))))) return fail("node identity, state or shape");
      nodeIds.add(n.id);
      localIds.add(n.id);
      if (nodeIds.size > 10000) return fail("too many nodes");
    }
    for (const n of g.nodes) if (n.dependsOn.some((d: string) => d === n.id || !localIds.has(d))) return fail(`dangling dependency in ${g.id}`);
  }
  const project = p as unknown as PlanningProject;
  const root = project.graphs.find(g => g.id === project.rootGraphId);
  if (!root || root.level !== 1 || root.parentNodeId) return fail("root graph");
  const children = new Set<string>();
  for (const g of project.graphs) for (const n of g.nodes) {
    if (!n.childGraphId) continue;
    const child = project.graphs.find(c => c.id === n.childGraphId);
    if (!child || child.parentNodeId !== n.id || child.level !== g.level + 1 || children.has(child.id)) return fail(`child graph for ${n.id}`);
    children.add(child.id);
  }
  if (project.graphs.some(g => g !== root && !children.has(g.id))) return fail("orphan graph");
  return project;
}

/** Maproom data takes precedence when a project has both formats. */
export function findPlanningProjectSource(entry: Pick<ProjectRead, "root">): PlanningSourceFile | null {
  const root = fs.realpathSync(entry.root);
  const maproom = path.join(root, ".maproom", "project.json");
  if (fs.existsSync(maproom)) return { filename: maproom, kind: "maproom" };
  const openrig = path.join(root, "planning.json");
  if (fs.existsSync(openrig)) return { filename: openrig, kind: "openrig" };
  return null;
}

export function readPlanningProject(entry: Pick<ProjectRead, "id" | "root">) {
  const root = fs.realpathSync(entry.root);
  const selected = findPlanningProjectSource({ root });
  if (!selected) throw new Error(`No planning source found for project ${entry.id}`);
  const { filename, kind } = selected;
  const canonical = insideProject(root, filename);
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  let modifiedAt: string;
  try {
    if (insideProject(root, filename) !== canonical) throw new Error("Planning source changed while opening; refresh to retry");
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Planning source must be a file no larger than 20 MiB");
    bytes = fs.readFileSync(fd);
    modifiedAt = info.mtime.toISOString();
  } finally { fs.closeSync(fd); }
  const project = parsePlanningProject(JSON.parse(bytes.toString("utf8")), entry.id);
  return { project, source: { kind, mode: "linked" as const, path: filename,
    sha256: createHash("sha256").update(bytes).digest("hex"), readAt: new Date().toISOString(),
    modifiedAt } };
}
