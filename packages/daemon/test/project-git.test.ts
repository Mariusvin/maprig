import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { projectGitRoutes } from "../src/routes/project-git.js";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function initializeRepository(repository: string, identity = true): void {
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-q", repository], { windowsHide: true });
  if (identity) {
    git(repository, "config", "user.name", "Project Git Test");
    git(repository, "config", "user.email", "project-git-test@openrig.invalid");
  }
}

function fixture(sourceRoot: "." | "source" = "source", identity = true) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "project-git-test-"));
  roots.push(workspace);
  const project = path.join(workspace, "demo");
  const repository = sourceRoot === "." ? project : path.join(project, sourceRoot);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(workspace, "workspace.yaml"), "projects:\n  - id: demo\n    root: demo\n", "utf8");
  fs.writeFileSync(path.join(project, "project.yaml"), `id: demo\nsource:\n  root: ${sourceRoot}\nmissions:\n  root: .openrig-project/missions\n`, "utf8");
  initializeRepository(repository, identity);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, {
      resolveOne: (key: string) => ({ value: key === "workspace.root" ? workspace : key === "workspace.catalog_path" ? path.join(workspace, "workspace.yaml") : "" }),
    } as never);
    await next();
  });
  app.route("/api/project-git", projectGitRoutes({ bearerToken: "project-git-test-token" }));
  return { app, workspace, project, repository };
}

function seedCommit(repository: string, entries: Record<string, string>): void {
  for (const [name, contents] of Object.entries(entries)) {
    const file = path.join(repository, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }
  git(repository, "add", "--all");
  git(repository, "commit", "-m", "fixture base");
}

async function state(app: Hono) {
  const response = await app.request("/api/project-git/demo");
  expect(response.status).toBe(200);
  return await response.json() as {
    repository: string;
    head: string | null;
    branch: string;
    identity: { name: string | null; email: string | null };
    changes: Array<{ path: string; status: string }>;
    fingerprint: string;
  };
}

async function commit(app: Hono, request: unknown, token = true) {
  return await app.request("/api/project-git/demo/commit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer project-git-test-token" } : {}),
    },
    body: JSON.stringify(request),
  });
}

describe("project Git routes", () => {
  it("uses a declared source subtree and supports an unborn repo with a spaced untracked path", async () => {
    const { app, repository } = fixture("source");
    fs.writeFileSync(path.join(repository, "new file.txt"), "initial content\n", "utf8");

    const current = await state(app);
    expect(current.repository).toBe(fs.realpathSync(repository));
    expect(current.head).toBeNull();
    expect(current.branch.length).toBeGreaterThan(0);
    expect(current.changes).toContainEqual({ path: "new file.txt", status: "??" });
    expect(current.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const diff = await app.request("/api/project-git/demo/diff?path=new%20file.txt");
    expect(diff.status).toBe(200);
    expect((await diff.json()).diff).toContain("initial content");

    const unauthorized = await commit(app, {
      message: "Add initial file",
      paths: ["new file.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    }, false);
    expect(unauthorized.status).toBe(401);

    const response = await commit(app, {
      message: "Add initial file",
      paths: ["new file.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { commit: string; remainingChanges: number };
    expect(result.commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(result.remainingChanges).toBe(0);
    expect(git(repository, "show", "HEAD:new file.txt")).toBe("initial content");
  });

  it("creates commits in a copied project repository without changing its source origin", async () => {
    const { app, workspace, repository } = fixture("source");
    const origin = path.join(workspace, "source-origin");
    initializeRepository(origin);
    seedCommit(origin, { "copy.txt": "origin baseline\n" });
    const originHead = git(origin, "rev-parse", "HEAD");

    fs.rmSync(repository, { recursive: true, force: true });
    execFileSync("git", ["clone", "--quiet", origin, repository], { windowsHide: true });
    git(repository, "config", "user.name", "Project Copy");
    git(repository, "config", "user.email", "project-copy@openrig.invalid");
    fs.writeFileSync(path.join(repository, "copy.txt"), "project copy change\n", "utf8");
    const current = await state(app);

    const response = await commit(app, {
      message: "Commit copied project",
      paths: ["copy.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });
    expect(response.status).toBe(200);
    expect(git(repository, "show", "HEAD:copy.txt")).toBe("project copy change");
    expect(git(origin, "rev-parse", "HEAD")).toBe(originHead);
    expect(git(origin, "show", "HEAD:copy.txt")).toBe("origin baseline");
  });

  it("commits only selected files and preserves unrelated pre-staged changes", async () => {
    const { app, repository } = fixture(".");
    seedCommit(repository, { "selected.txt": "before\n", "unrelated.txt": "base\n" });
    fs.writeFileSync(path.join(repository, "selected.txt"), "selected commit\n", "utf8");
    fs.writeFileSync(path.join(repository, "unrelated.txt"), "still staged separately\n", "utf8");
    git(repository, "add", "--", "unrelated.txt");

    const current = await state(app);
    const response = await commit(app, {
      message: "Commit selected file",
      paths: ["selected.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { commit: string; remainingChanges: number };
    expect(git(repository, "show", "HEAD:selected.txt")).toBe("selected commit");
    expect(git(repository, "show", "HEAD:unrelated.txt")).toBe("base");
    expect(git(repository, "diff", "--cached", "--", "unrelated.txt")).toContain("still staged separately");
    expect(git(repository, "status", "--porcelain=v1", "-z", "--no-renames")).toContain("M  unrelated.txt");
    expect(result.remainingChanges).toBe(1);
  });

  it("detects content changes with the same porcelain path before committing", async () => {
    const { app, repository } = fixture("source");
    seedCommit(repository, { "same status.txt": "before\n" });
    fs.writeFileSync(path.join(repository, "same status.txt"), "first edit\n", "utf8");
    const stale = await state(app);
    fs.writeFileSync(path.join(repository, "same status.txt"), "different edit with same status\n", "utf8");

    const response = await commit(app, {
      message: "Must be rejected",
      paths: ["same status.txt"],
      expectedHead: stale.head,
      expectedFingerprint: stale.fingerprint,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("project_git_stale");
    expect(git(repository, "rev-parse", "HEAD")).toBe(stale.head);
  });

  it("commits a rename as the selected spaced source and destination paths", async () => {
    const { app, repository } = fixture("source");
    seedCommit(repository, { "old name.txt": "rename me\n" });
    fs.renameSync(path.join(repository, "old name.txt"), path.join(repository, "new name.txt"));
    const current = await state(app);
    expect(current.changes.map(change => change.path)).toEqual(["new name.txt", "old name.txt"]);

    const response = await commit(app, {
      message: "Rename spaced file",
      paths: ["old name.txt", "new name.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });
    expect(response.status).toBe(200);
    expect(git(repository, "show", "HEAD:new name.txt")).toBe("rename me");
    expect(() => git(repository, "show", "HEAD:old name.txt")).toThrow();
  });

  it("refuses traversal and .git path selections", async () => {
    const { app, repository } = fixture("source");
    seedCommit(repository, { "tracked.txt": "base\n" });
    fs.writeFileSync(path.join(repository, "tracked.txt"), "changed\n", "utf8");
    const current = await state(app);
    const request = (selectedPath: string) => commit(app, {
      message: "Invalid path",
      paths: [selectedPath],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });

    expect((await request("../outside.txt")).status).toBe(400);
    expect((await request(".git/config")).status).toBe(400);
    expect(git(repository, "rev-parse", "HEAD")).toBe(current.head);
  });

  it("enforces source.root containment and an exact independent Git top-level", async () => {
    const escaped = fixture("source");
    const outside = path.join(escaped.workspace, "outside");
    initializeRepository(outside);
    seedCommit(outside, { "outside.txt": "must remain untouched\n" });
    const outsideHead = git(outside, "rev-parse", "--verify", "HEAD");
    fs.writeFileSync(path.join(escaped.project, "project.yaml"), "id: demo\nsource:\n  root: ../outside\n", "utf8");
    const escapedResponse = await escaped.app.request("/api/project-git/demo");
    expect(escapedResponse.status).toBe(409);
    expect((await escapedResponse.json()).error).toBe("invalid_source_root");
    expect(git(outside, "rev-parse", "HEAD")).toBe(outsideHead);

    const nested = fixture(".");
    fs.mkdirSync(path.join(nested.project, "source"));
    fs.writeFileSync(path.join(nested.project, "project.yaml"), "id: demo\nsource:\n  root: source\n", "utf8");
    const nestedResponse = await nested.app.request("/api/project-git/demo");
    expect(nestedResponse.status).toBe(409);
    expect((await nestedResponse.json()).error).toBe("git_repository_mismatch");
  });

  it("reports a missing commit identity clearly", async () => {
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    const oldNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const { app, repository, workspace } = fixture("source", false);
    process.env.GIT_CONFIG_GLOBAL = path.join(workspace, "empty-global-config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      fs.writeFileSync(path.join(repository, "no-identity.txt"), "pending\n", "utf8");
      const current = await state(app);
      expect(current.identity).toEqual({ name: null, email: null });
      const response = await commit(app, {
        message: "Cannot commit",
        paths: ["no-identity.txt"],
        expectedHead: current.head,
        expectedFingerprint: current.fingerprint,
      });
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("user.name and user.email");
    } finally {
      if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
      if (oldNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = oldNoSystem;
    }
  });

  it("surfaces a rejected commit hook and keeps HEAD unchanged", async () => {
    const { app, repository } = fixture("source");
    seedCommit(repository, { "hooked.txt": "base\n" });
    fs.writeFileSync(path.join(repository, "hooked.txt"), "pending\n", "utf8");
    const hooks = path.join(repository, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    git(repository, "config", "core.hooksPath", hooks);
    const hook = path.join(hooks, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho commit rejected by test hook >&2\nexit 1\n", "utf8");
    fs.chmodSync(hook, 0o755);
    const current = await state(app);

    const response = await commit(app, {
      message: "Hook should reject",
      paths: ["hooked.txt"],
      expectedHead: current.head,
      expectedFingerprint: current.fingerprint,
    });
    expect(response.status).toBe(422);
    expect((await response.json()).message).toContain("commit rejected by test hook");
    expect(git(repository, "rev-parse", "HEAD")).toBe(current.head);
  });

  it("refuses to finalize an unresolved merge and preserves its index and operation state", async () => {
    const { app, repository } = fixture(".");
    seedCommit(repository, { "conflict.txt": "base\n" });
    const branch = git(repository, "symbolic-ref", "--short", "HEAD");
    git(repository, "checkout", "-q", "-b", "incoming");
    fs.writeFileSync(path.join(repository, "conflict.txt"), "incoming\n");
    git(repository, "add", "conflict.txt"); git(repository, "commit", "-qm", "Incoming");
    git(repository, "checkout", "-q", branch);
    fs.writeFileSync(path.join(repository, "conflict.txt"), "current\n");
    git(repository, "add", "conflict.txt"); git(repository, "commit", "-qm", "Current");
    expect(() => git(repository, "merge", "incoming")).toThrow();
    const before = git(repository, "ls-files", "--stage");
    const current = await state(app);
    expect(current.operation).toBe("MERGE_HEAD");
    const response = await commit(app, { message: "Must not finalize merge", paths: ["conflict.txt"], expectedHead: current.head, expectedFingerprint: current.fingerprint });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("git_operation_active");
    expect(git(repository, "ls-files", "--stage")).toBe(before);
    expect(git(repository, "rev-parse", "HEAD")).toBe(current.head);
    expect(fs.existsSync(path.join(repository, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("rejects an operation started after the status read", async () => {
    const { app, repository } = fixture(".");
    seedCommit(repository, { "file.txt": "base\n" });
    fs.writeFileSync(path.join(repository, "file.txt"), "changed\n");
    const current = await state(app);
    fs.mkdirSync(path.join(repository, ".git", "rebase-merge"));
    const response = await commit(app, { message: "Must not interrupt rebase", paths: ["file.txt"], expectedHead: current.head, expectedFingerprint: current.fingerprint });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("git_operation_active");
    expect(git(repository, "rev-parse", "HEAD")).toBe(current.head);
  });

  it.skipIf(process.platform === "win32")("preserves a literal POSIX backslash filename through status, diff and commit", async () => {
    const { app, repository } = fixture(".");
    seedCommit(repository, { "base.txt": "base\n" });
    const filename = "literal\\name.txt";
    fs.writeFileSync(path.join(repository, filename), "literal filename\n");
    const current = await state(app);
    expect(current.changes.map((item: { path: string }) => item.path)).toContain(filename);
    const diff = await app.request(`/api/project-git/demo/diff?path=${encodeURIComponent(filename)}`);
    expect(diff.status).toBe(200);
    expect((await diff.json()).diff).toContain("+literal filename");
    const response = await commit(app, { message: "Preserve literal filename", paths: [filename], expectedHead: current.head, expectedFingerprint: current.fingerprint });
    expect(response.status).toBe(200);
    expect(git(repository, "show", `HEAD:${filename}`)).toBe("literal filename");
  });
});
