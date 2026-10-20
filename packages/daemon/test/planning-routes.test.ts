import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planningRoutes } from "../src/routes/planning.js";
import { parsePlanningProject } from "../src/domain/workspace/planning-graph.js";

const node = (id: string, progress: number) => ({ id, title: id, status: "in_progress", progress, position: { x: 80, y: 90 }, dependsOn: [] as string[] });
const fixture = () => ({ version: 1, project: { id: "example", name: "Example", rootGraphId: "root", graphs: [
  { id: "root", title: "Milestones", level: 1, nodes: [{ ...node("a", 44), childGraphId: "detail" }, { ...node("b", 96), dependsOn: ["a"] }] },
  { id: "detail", title: "Deliverables", level: 2, parentNodeId: "a", nodes: [node("c", 73)] },
] } });
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planning-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".maproom"));
  fs.writeFileSync(path.join(root, "workspace.yaml"), "projects:\n  - id: example\n    root: .\n");
  const source = path.join(root, ".maproom", "project.json");
  fs.writeFileSync(source, JSON.stringify(fixture()));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : "" }) } as never);
    await next();
  });
  app.route("/api/planning", planningRoutes());
  return { root, source, app };
}
describe("linked planning graph", () => {
  it("preserves graph identity, dependencies, positions and authored percentages", async () => {
    const { app, source } = setup();
    const original = fs.readFileSync(source, "utf8");
    expect(await (await app.request("/api/planning")).json()).toEqual({ projects: [{ id: "example", name: "example" }] });
    const response = await app.request("/api/planning/example");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.project).toEqual(fixture().project);
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(source, "utf8")).toBe(original);
    const changed = fixture();
    changed.project.graphs[0]!.nodes[0]!.progress = 51;
    fs.writeFileSync(`${source}.tmp`, JSON.stringify(changed));
    fs.renameSync(`${source}.tmp`, source);
    const updated = await (await app.request("/api/planning/example")).json();
    expect(updated.project.graphs[0].nodes[0].progress).toBe(51);
    expect(updated.source.sha256).not.toBe(result.source.sha256);
  });
  it("reports invalid sources and refuses unrelated project IDs", async () => {
    const { app, source } = setup();
    expect((await app.request("/api/planning/other")).status).toBe(409);
    fs.writeFileSync(source, "broken json");
    expect((await app.request("/api/planning/example")).status).toBe(409);
  });
  it("rejects identity mismatch, dangling dependencies, duplicate nodes and broken hierarchy", () => {
    expect(() => parsePlanningProject(fixture(), "other")).toThrow(/identity/);
    const dangling = fixture();
    dangling.project.graphs[0]!.nodes[1]!.dependsOn = ["missing"];
    expect(() => parsePlanningProject(dangling, "example")).toThrow(/dependency/);
    const duplicate = fixture();
    duplicate.project.graphs[1]!.nodes[0]!.id = "a";
    expect(() => parsePlanningProject(duplicate, "example")).toThrow(/identity/);
    const broken = fixture();
    broken.project.graphs[1]!.parentNodeId = "b";
    expect(() => parsePlanningProject(broken, "example")).toThrow(/child graph/);
    const invalid = fixture();
    invalid.project.graphs[0]!.nodes[0]!.progress = 101;
    expect(() => parsePlanningProject(invalid, "example")).toThrow(/state/);
  });
  it.skipIf(process.platform === "win32")("rejects a planning source symlink outside the registered project", async () => {
    const { app, source } = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "planning-outside-test-"));
    roots.push(outside);
    const filename = path.join(outside, "private.json");
    fs.writeFileSync(filename, JSON.stringify(fixture()));
    fs.unlinkSync(source);
    fs.symlinkSync(filename, source);
    expect((await app.request("/api/planning/example")).status).toBe(409);
  });
});
