import { Hono } from "hono";
import { declaredProject, listProjects, projectReadResponse } from "../domain/workspace/project-read.js";
import { findPlanningProjectSource, readPlanningProject } from "../domain/workspace/planning-graph.js";

/** Read-only planning integration. It never writes to planning sources or the execution queue. */
export function planningRoutes(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/", c => {
    try {
      const { projects } = listProjects(c);
      return c.json({ projects: projects.flatMap(p => {
        let source: ReturnType<typeof findPlanningProjectSource>;
        try { source = findPlanningProjectSource(p); } catch { return []; }
        if (!source) return [];
        let name = p.name;
        try { name = readPlanningProject(p).project.name; } catch { /* Keep invalid sources visible with their catalog name. */ }
        return [{ id: p.id, name, source: { kind: source.kind } }];
      }) });
    } catch (error) { return projectReadResponse(error); }
  });
  app.get("/:id", c => {
    try { return c.json(readPlanningProject(declaredProject(c, c.req.param("id")))); }
    catch (error) { return projectReadResponse(error); }
  });
  return app;
}
