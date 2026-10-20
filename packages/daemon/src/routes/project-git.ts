import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { declaredProject, projectReadResponse, projectCatalogPaths } from "../domain/workspace/project-read.js";
import {
  commitProjectGitChanges,
  ProjectGitError,
  projectIsExplicitlyDeclared,
  readProjectGitDiff,
  readProjectGitState,
  resolveProjectGitRepository,
  type ProjectGitCommitInput,
} from "../domain/workspace/project-git.js";

function projectRepository(c: Parameters<typeof declaredProject>[0] & { req: { param: (name: string) => string } }): string {
  const project = declaredProject(c, c.req.param("id"));
  const { catalog } = projectCatalogPaths(c);
  const explicitlyDeclared = projectIsExplicitlyDeclared(project, catalog);
  return resolveProjectGitRepository(project, explicitlyDeclared);
}

function errorResponse(c: Parameters<typeof declaredProject>[0] & { json: (value: unknown, status?: ContentfulStatusCode) => Response }, error: unknown): Response {
  if (error instanceof ProjectGitError) {
    return c.json({ error: error.code, message: error.message }, error.status as ContentfulStatusCode);
  }
  if (error instanceof Error && "code" in error) {
    return projectReadResponse(error);
  }
  const message = error instanceof Error ? error.message : "Unexpected project Git failure";
  return c.json({ error: "project_git_internal", message }, 500);
}

/** Read-only status and diff endpoints plus bearer-protected selected-path commits. */
export function projectGitRoutes(opts?: { bearerToken?: string | null }): Hono {
  const app = new Hono();

  app.get("/:id/diff", c => {
    try {
      const repository = projectRepository(c);
      const requestedPath = c.req.query("path");
      if (requestedPath === undefined) {
        return c.json({ error: "path_required", message: "Provide one changed repository-relative path in the path query parameter." }, 400);
      }
      return c.json(readProjectGitDiff(repository, requestedPath));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/:id", c => {
    try {
      const repository = projectRepository(c);
      return c.json(readProjectGitState(repository));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/:id/commit", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }), async c => {
    try {
      const repository = projectRepository(c);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json", message: "Commit request body must be valid JSON." }, 400);
      }
      const result = await commitProjectGitChanges(repository, body as ProjectGitCommitInput);
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}
