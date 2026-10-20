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
function setup(sources: "maproom" | "openrig" | "both" = "maproom") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "planning-test-"));
  roots.push(root);
  if (sources !== "openrig") fs.mkdirSync(path.join(root, ".maproom"));
  fs.writeFileSync(path.join(root, "workspace.yaml"), "projects:\n  - id: example\n    root: .\n");
  const maproomSource = path.join(root, ".maproom", "project.json");
  const openrigSource = path.join(root, "planning.json");
  if (sources !== "openrig") fs.writeFileSync(maproomSource, JSON.stringify(fixture()));
  if (sources !== "maproom") {
    const native = fixture();
    native.project.name = "Native Example";
    native.project.graphs[0]!.nodes[0]!.progress = 87;
    fs.writeFileSync(openrigSource, JSON.stringify(native));
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : "" }) } as never);
    await next();
  });
  app.route("/api/planning", planningRoutes());
  return { root, maproomSource, openrigSource, source: sources === "openrig" ? openrigSource : maproomSource, app };
}
describe("linked planning graph", () => {
  it("preserves graph identity, dependencies, positions and authored percentages", async () => {
    const { app, source } = setup();
    const original = fs.readFileSync(source, "utf8");
    expect(await (await app.request("/api/planning")).json()).toEqual({ projects: [{ id: "example", name: "Example", source: { kind: "maproom" } }] });
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
  it("reads native OpenRig planning.json with its display name and source kind", async () => {
    const { app, source } = setup("openrig");
    const original = fs.readFileSync(source, "utf8");
    const catalog = await (await app.request("/api/planning")).json();
    expect(catalog.projects).toEqual([{ id: "example", name: "Native Example", source: { kind: "openrig" } }]);
    const response = await app.request("/api/planning/example");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.project.name).toBe("Native Example");
    expect(result.project.graphs[0].nodes[0].progress).toBe(87);
    expect(result.source.kind).toBe("openrig");
    expect(result.source.path).toBe(source);
    expect(fs.readFileSync(source, "utf8")).toBe(original);
  });
  it("prefers the Maproom source when both formats are present", async () => {
    const { app, maproomSource, openrigSource } = setup("both");
    const response = await app.request("/api/planning/example");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.source.kind).toBe("maproom");
    expect(result.source.path).toBe(maproomSource);
    expect(result.project.name).toBe("Example");
    expect(result.project.graphs[0].nodes[0].progress).toBe(44);
    expect(JSON.parse(fs.readFileSync(openrigSource, "utf8")).project.graphs[0].nodes[0].progress).toBe(87);
  });
  it("reports invalid sources and refuses unrelated project IDs", async () => {
    const { app, source } = setup();
    expect((await app.request("/api/planning/other")).status).toBe(409);
    fs.writeFileSync(source, "broken json");
    expect((await app.request("/api/planning/example")).status).toBe(409);
  });
  it("checks native project identity against the registered project ID", async () => {
    const { app, source } = setup("openrig");
    const wrongIdentity = fixture();
    wrongIdentity.project.id = "other";
    fs.writeFileSync(source, JSON.stringify(wrongIdentity));
    const response = await app.request("/api/planning/example");
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain("identity");
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
  it.skipIf(process.platform === "win32")("rejects a native planning.json symlink outside the registered project", async () => {
    const { app, source } = setup("openrig");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "planning-outside-test-"));
    roots.push(outside);
    const filename = path.join(outside, "private.json");
    fs.writeFileSync(filename, JSON.stringify(fixture()));
    fs.unlinkSync(source);
    fs.symlinkSync(filename, source);
    expect((await app.request("/api/planning/example")).status).toBe(409);
  });
});
