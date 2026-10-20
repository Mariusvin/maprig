import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { declaredProject, listProjects, projectReadResponse } from "../domain/workspace/project-read.js";
import { readPlanningProject } from "../domain/workspace/planning-graph.js";

/** Read-through integration. No importer writes to the Maproom source or execution queue. */
export function planningRoutes(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/", c => {
    try {
      const { projects } = listProjects(c);
      return c.json({ projects: projects.filter(p => fs.existsSync(path.join(p.root, ".maproom", "project.json")))
        .map(p => ({ id: p.id, name: p.name })) });
    } catch (error) { return projectReadResponse(error); }
  });
  app.get("/:id", c => {
    try { return c.json(readPlanningProject(declaredProject(c, c.req.param("id")))); }
    catch (error) { return projectReadResponse(error); }
  });
  return app;
}
