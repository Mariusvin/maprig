import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readProjectCatalog, yamlObject } from "./project-catalog.js";
import type { ProjectRead } from "./project-read.js";

export class ProjectGitError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "ProjectGitError";
  }
}

export interface ProjectGitChange {
  path: string;
  status: string;
}

export interface ProjectGitState {
  repository: string;
  head: string | null;
  branch: string;
  identity: { name: string | null; email: string | null };
  changes: ProjectGitChange[];
  fingerprint: string;
}

export interface ProjectGitCommitInput {
  message: string;
  paths: string[];
  expectedHead: string | null;
  expectedFingerprint: string;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number;
}

interface ChangeRecord extends ProjectGitChange {
  readonly rawPath: string;
}

const repositoryLocks = new Map<string, Promise<void>>();
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonicalPathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function errorText(buffer: Buffer): string {
  return buffer.toString("utf8").trim().replace(/\s+/g, " ");
}

function runGitAt(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const gitEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_SUPER_PREFIX",
    "GIT_NAMESPACE",
  ]) delete gitEnvironment[key];
  if (env) Object.assign(gitEnvironment, env);
  try {
    const stdout = execFileSync("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      env: gitEnvironment,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    }) as Buffer;
    return { stdout, stderr: Buffer.alloc(0), status: 0 };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    if (cause.code === "ENOENT") {
      throw new ProjectGitError("git_unavailable", "Git is not available on the daemon process PATH.", 503);
    }
    const stdout = Buffer.isBuffer(cause.stdout) ? cause.stdout : Buffer.from(cause.stdout ?? "", "utf8");
    const stderr = Buffer.isBuffer(cause.stderr) ? cause.stderr : Buffer.from(cause.stderr ?? "", "utf8");
    return { stdout, stderr, status: cause.status ?? 1 };
  }
}

function requireGit(cwd: string, args: string[], options?: { env?: NodeJS.ProcessEnv; code?: string; message?: string; status?: number }): Buffer {
  const result = runGitAt(cwd, args, options?.env);
  if (result.status !== 0) {
    const details = errorText(result.stderr) || errorText(result.stdout) || `exit code ${result.status}`;
    throw new ProjectGitError(
      options?.code ?? "git_command_failed",
      options?.message ? `${options.message}: ${details}` : `Git ${args[0] ?? "command"} failed: ${details}`,
      options?.status ?? 409,
    );
  }
  return result.stdout;
}

function resolveSourceRoot(project: ProjectRead, explicitlyDeclared: boolean): string {
  let projectRoot: string;
  try {
    projectRoot = fs.realpathSync(project.root);
  } catch {
    throw new ProjectGitError("project_root_missing", `Project ${project.id} root is unavailable: ${project.root}`);
  }

  let manifest: Record<string, any> | null = null;
  const manifestPath = path.join(projectRoot, "project.yaml");
  if (fs.existsSync(manifestPath)) {
    let manifestReal: string;
    try {
      manifestReal = fs.realpathSync(manifestPath);
    } catch {
      throw new ProjectGitError("project_manifest_unavailable", "Project manifest cannot be resolved safely.");
    }
    if (!isInside(projectRoot, manifestReal)) {
      throw new ProjectGitError("project_manifest_escape", "Project manifest resolves outside the registered project root.");
    }
    manifest = yamlObject(manifestReal);
  }

  if (manifest?.source !== undefined && (manifest.source === null || typeof manifest.source !== "object" || Array.isArray(manifest.source))) {
    throw new ProjectGitError("invalid_source_root", "project.yaml source must be an object containing a relative root path.");
  }
  const sourceRootValue: unknown = manifest?.source?.root;
  let relativeSource = sourceRootValue;
  if (relativeSource === undefined) {
    if (!explicitlyDeclared && !manifest) {
      throw new ProjectGitError("project_not_explicit", "Git access requires a project declared in the workspace catalog or project.yaml.");
    }
    relativeSource = ".";
  }
  if (typeof relativeSource !== "string" || !relativeSource.trim()) {
    throw new ProjectGitError("invalid_source_root", "project.yaml source.root must be a non-empty relative path.");
  }
  const normalizedSource = relativeSource.replace(/[\\/]+/g, path.sep);
  const segments = normalizedSource.split(path.sep);
  if (
    path.isAbsolute(normalizedSource) ||
    path.win32.isAbsolute(relativeSource) ||
    path.win32.parse(relativeSource).root !== "" ||
    segments.includes("..")
  ) {
    throw new ProjectGitError("invalid_source_root", "project.yaml source.root must stay inside the registered project root.");
  }

  const nominal = path.resolve(projectRoot, normalizedSource);
  if (!isInside(projectRoot, nominal)) {
    throw new ProjectGitError("source_root_escape", "Project source root resolves outside the registered project root.");
  }
  let sourceRoot: string;
  try {
    sourceRoot = fs.realpathSync(nominal);
  } catch {
    throw new ProjectGitError("source_root_missing", `Project source root is unavailable: ${relativeSource}`);
  }
  if (!isInside(projectRoot, sourceRoot)) {
    throw new ProjectGitError("source_root_escape", "Project source root resolves outside the registered project root.");
  }
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new ProjectGitError("source_root_invalid", "Project source.root must resolve to a directory.");
  }
  return sourceRoot;
}

/** Resolves the explicitly declared source subtree and refuses parent Git repositories. */
export function resolveProjectGitRepository(project: ProjectRead, explicitlyDeclared: boolean): string {
  const sourceRoot = resolveSourceRoot(project, explicitlyDeclared);
  const inWorkTree = requireGit(sourceRoot, ["rev-parse", "--is-inside-work-tree"], { message: "Project source is not a Git working tree" }).toString("utf8").trim();
  if (inWorkTree !== "true") {
    throw new ProjectGitError("git_repository_missing", `Project source root is not a Git working tree: ${sourceRoot}`);
  }
  const topLevel = requireGit(sourceRoot, ["rev-parse", "--show-toplevel"], { message: "Could not resolve project Git root" }).toString("utf8").trim();
  let actualTopLevel: string;
  try {
    actualTopLevel = fs.realpathSync(topLevel);
  } catch {
    throw new ProjectGitError("git_repository_missing", "Git reported a repository root that cannot be resolved.");
  }
  if (canonicalPathKey(actualTopLevel) !== canonicalPathKey(sourceRoot)) {
    throw new ProjectGitError("git_repository_mismatch", "The declared project source root must be the exact top-level of its own Git repository.");
  }
  return actualTopLevel;
}

function normalizeGitPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new ProjectGitError("invalid_path", "Each Git path must be a non-empty repository-relative path.", 400);
  }
  const normalized = input.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git")
  ) {
    throw new ProjectGitError("invalid_path", `Git path must stay inside the repository and cannot select .git: ${input}`, 400);
  }
  return segments.join("/");
}

function pathOnDisk(repository: string, relativePath: string): string {
  const normalized = normalizeGitPath(relativePath);
  const segments = normalized.split("/");
  let current = repository;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const last = index === segments.length - 1;
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }

    if (info.isSymbolicLink()) {
      if (last) {
        const parent = fs.realpathSync(path.dirname(current));
        if (!isInside(repository, parent)) {
          throw new ProjectGitError("path_escape", `Git path resolves through a parent outside the repository: ${relativePath}`, 400);
        }
        return current;
      }
    }
    const actual = fs.realpathSync(current);
    if (!isInside(repository, actual)) {
      throw new ProjectGitError("path_escape", `Git path resolves outside the repository: ${relativePath}`, 400);
    }
    if (!last && !fs.statSync(actual).isDirectory()) {
      throw new ProjectGitError("invalid_path", `Git path parent is not a directory: ${relativePath}`, 400);
    }
  }
  return current;
}

function readStatus(repository: string): ChangeRecord[] {
  const raw = requireGit(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], {
    env: { GIT_OPTIONAL_LOCKS: "0" },
    message: "Could not read project Git status",
  });
  const entries = raw.toString("utf8").split("\0");
  const changes: ChangeRecord[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") {
      throw new ProjectGitError("git_status_invalid", "Git returned an unrecognized project status record.", 500);
    }
    const pathValue = entry.slice(3);
    const normalized = normalizeGitPath(pathValue);
    pathOnDisk(repository, normalized);
    changes.push({ path: normalized, rawPath: pathValue, status: entry.slice(0, 2) });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return changes;
}

function readWorktreeValue(repository: string, changePath: string): Buffer {
  const absolute = pathOnDisk(repository, changePath);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.from("missing\0", "utf8");
    throw error;
  }
  const metadata = Buffer.from(`${info.mode & 0o777}\0`, "utf8");
  if (info.isSymbolicLink()) {
    return Buffer.concat([Buffer.from("symlink\0", "utf8"), metadata, Buffer.from(fs.readlinkSync(absolute), "utf8")]);
  }
  if (info.isFile()) {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const fd = fs.openSync(absolute, "r");
    try {
      let length: number;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    } finally { fs.closeSync(fd); }
    return Buffer.concat([Buffer.from("file\0", "utf8"), metadata, hash.digest()]);
  }
  if (info.isDirectory()) {
    let nestedState: { head: string | null; branch: string };
    let nestedChanges: ChangeRecord[];
    try {
      nestedState = readHead(absolute);
      nestedChanges = readStatus(absolute);
    } catch {
      throw new ProjectGitError("unsupported_git_directory", `Changed Git directory is not a readable submodule: ${changePath}`);
    }
    const nestedIdentity = readIdentity(absolute);
    const nestedFingerprint = calculateFingerprint(absolute, nestedState.head, nestedState.branch, nestedIdentity, nestedChanges);
    return Buffer.concat([Buffer.from("gitlink\0", "utf8"), metadata, Buffer.from(nestedFingerprint, "utf8")]);
  }
  return Buffer.from(`other\0${metadata.toString("utf8")}`, "utf8");
}

function readIndexValue(repository: string, changePath: string): Buffer {
  return requireGit(repository, ["ls-files", "--stage", "-z", "--", changePath], {
    env: { GIT_OPTIONAL_LOCKS: "0" },
    message: "Could not read project Git index",
  });
}

function readHead(repository: string): { head: string | null; branch: string } {
  const headResult = runGitAt(repository, ["rev-parse", "--verify", "HEAD"], { GIT_OPTIONAL_LOCKS: "0" });
  const branchResult = runGitAt(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], { GIT_OPTIONAL_LOCKS: "0" });
  if (headResult.status === 0) {
    return {
      head: headResult.stdout.toString("utf8").trim(),
      branch: branchResult.status === 0 ? branchResult.stdout.toString("utf8").trim() : "(detached HEAD)",
    };
  }
  if (branchResult.status === 0) {
    return { head: null, branch: branchResult.stdout.toString("utf8").trim() };
  }
  const details = errorText(headResult.stderr) || errorText(headResult.stdout) || "Git HEAD could not be resolved";
  throw new ProjectGitError("git_head_unavailable", details);
}

function readIdentity(repository: string): { name: string | null; email: string | null } {
  const read = (key: string): string | null => {
    const result = runGitAt(repository, ["config", "--get", key], { GIT_OPTIONAL_LOCKS: "0" });
    return result.status === 0 ? result.stdout.toString("utf8").trim() || null : null;
  };
  return { name: read("user.name"), email: read("user.email") };
}

function calculateFingerprint(
  repository: string,
  head: string | null,
  branch: string,
  identity: { name: string | null; email: string | null },
  changes: ChangeRecord[],
): string {
  const hash = createHash("sha256");
  const part = (value: string | Buffer) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  part("openrig-project-git-state-v1");
  part(head ?? "<unborn>");
  part(branch);
  part(identity.name ?? "<missing-name>");
  part(identity.email ?? "<missing-email>");
  for (const change of changes) {
    part(change.status);
    part(change.path);
    part(readIndexValue(repository, change.path));
    part(readWorktreeValue(repository, change.path));
  }
  return hash.digest("hex");
}

function inspectRepository(repository: string): ProjectGitState {
  const { head, branch } = readHead(repository);
  const changes = readStatus(repository);
  const identity = readIdentity(repository);
  return {
    repository,
    head,
    branch,
    identity,
    changes: changes.map(({ path: changedPath, status }) => ({ path: changedPath, status })),
    fingerprint: calculateFingerprint(repository, head, branch, identity, changes),
  };
}

export function readProjectGitState(repository: string): ProjectGitState {
  return inspectRepository(repository);
}

function diffUntrackedPath(repository: string, changedPath: string): Buffer {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-project-git-diff-"));
  const emptyPath = path.join(directory, "empty");
  try {
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const result = runGitAt(repository, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", emptyPath, changedPath], { GIT_OPTIONAL_LOCKS: "0" });
    if (result.status !== 0 && result.status !== 1) {
      throw new ProjectGitError("git_diff_failed", `Could not read project diff: ${errorText(result.stderr) || errorText(result.stdout) || `exit code ${result.status}`}`, 409);
    }
    const outputLines = result.stdout.toString("utf8").split("\n");
    const quotePath = (value: string) => /[\s"\\]/.test(value)
      ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\t/g, "\\t").replace(/\n/g, "\\n")}"`
      : value;
    outputLines[0] = `diff --git ${quotePath(`a/${changedPath}`)} ${quotePath(`b/${changedPath}`)}`;
    const oldPathLine = outputLines.findIndex(line => line.startsWith("--- "));
    if (oldPathLine >= 0) outputLines[oldPathLine] = "--- /dev/null";
    const output = outputLines.join("\n");
    return Buffer.from(output, "utf8");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withRepositoryLock<T>(repository: string, action: () => T | Promise<T>): Promise<T> {
  const key = canonicalPathKey(repository);
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  repositoryLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (repositoryLocks.get(key) === current) repositoryLocks.delete(key);
  }
}

function temporaryIndex(repository: string, action: (indexFile: string, env: NodeJS.ProcessEnv) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-project-git-"));
  const indexFile = path.join(directory, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    action(indexFile, env);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validateCommitInput(input: ProjectGitCommitInput): { message: string; paths: string[]; expectedHead: string | null; expectedFingerprint: string } {
  if (!input || typeof input !== "object") throw new ProjectGitError("invalid_commit", "Commit request must be a JSON object.", 400);
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 10_000) {
    throw new ProjectGitError("invalid_commit_message", "Commit message must contain 1 to 10000 characters.", 400);
  }
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 500 || !input.paths.every(item => typeof item === "string")) {
    throw new ProjectGitError("invalid_commit_paths", "Select between 1 and 500 changed repository-relative paths.", 400);
  }
  if (input.expectedHead !== null && typeof input.expectedHead !== "string") {
    throw new ProjectGitError("invalid_expected_head", "expectedHead must be a commit id or null.", 400);
  }
  if (typeof input.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    throw new ProjectGitError("invalid_expected_fingerprint", "expectedFingerprint must be a SHA-256 fingerprint from the latest project state.", 400);
  }
  const paths = input.paths.map(normalizeGitPath);
  if (new Set(paths).size !== paths.length) {
    throw new ProjectGitError("duplicate_commit_path", "Commit request contains a duplicate path.", 400);
  }
  return { message: input.message.trim(), paths, expectedHead: input.expectedHead, expectedFingerprint: input.expectedFingerprint };
}

function gitCommitError(result: GitResult): ProjectGitError {
  const details = errorText(result.stderr) || errorText(result.stdout) || `exit code ${result.status}`;
  return new ProjectGitError("git_commit_failed", `Git commit failed: ${details}`, 422);
}

/** Commit selected worktree paths from an isolated index, leaving unrelated staged entries intact. */
export function commitProjectGitChanges(repository: string, input: ProjectGitCommitInput): Promise<{ commit: string; remainingChanges: number }> {
  return withRepositoryLock(repository, () => {
    const request = validateCommitInput(input);
    const initial = inspectRepository(repository);
    if (initial.head !== request.expectedHead || initial.fingerprint !== request.expectedFingerprint) {
      throw new ProjectGitError("project_git_stale", "Project files or Git state changed. Refresh the project status before committing.");
    }
    const currentPaths = new Set(initial.changes.map(change => change.path));
    for (const selectedPath of request.paths) {
      if (!currentPaths.has(selectedPath)) {
        throw new ProjectGitError("path_not_changed", `Selected path is not currently changed in this project: ${selectedPath}`, 409);
      }
      pathOnDisk(repository, selectedPath);
    }
    if (!initial.identity.name || !initial.identity.email) {
      throw new ProjectGitError("git_identity_missing", "Git commit identity is missing. Set user.name and user.email in Git configuration before committing.", 409);
    }

    temporaryIndex(repository, (_indexFile, env) => {
      const readTreeArgs = initial.head ? ["read-tree", initial.head] : ["read-tree", "--empty"];
      requireGit(repository, readTreeArgs, { env, message: "Could not prepare an isolated Git index" });
      requireGit(repository, ["add", "-A", "--", ...request.paths], { env, message: "Could not stage selected project paths", status: 422 });

      const refreshed = inspectRepository(repository);
      if (refreshed.head !== request.expectedHead || refreshed.fingerprint !== request.expectedFingerprint) {
        throw new ProjectGitError("project_git_stale", "Project files or Git state changed while the commit was being prepared. Refresh the project status.");
      }

      const commitResult = runGitAt(repository, ["commit", "-m", request.message], env);
      if (commitResult.status !== 0) throw gitCommitError(commitResult);

      const newHead = requireGit(repository, ["rev-parse", "--verify", "HEAD"], { message: "Git reported a successful commit but the new commit could not be resolved", status: 500 }).toString("utf8").trim();
      const resetResult = runGitAt(repository, ["reset", "--quiet", newHead, "--", ...request.paths]);
      if (resetResult.status !== 0) {
        const details = errorText(resetResult.stderr) || errorText(resetResult.stdout) || `exit code ${resetResult.status}`;
        throw new ProjectGitError("git_index_reconcile_failed", `Commit ${newHead} was created, but the main Git index could not be reconciled: ${details}`, 500);
      }
    });

    const result = inspectRepository(repository);
    const committed = result.head;
    if (!committed) throw new ProjectGitError("git_commit_missing", "Git commit completed without creating a commit.", 500);
    return { commit: committed, remainingChanges: result.changes.length };
  });
}

export function readProjectGitDiff(repository: string, requestedPath: string): { path: string; diff: string } {
  const changedPath = normalizeGitPath(requestedPath);
  const state = inspectRepository(repository);
  const change = state.changes.find(entry => entry.path === changedPath);
  if (!change) throw new ProjectGitError("path_not_changed", `Path is not currently changed in this project: ${changedPath}`, 409);
  pathOnDisk(repository, changedPath);

  let output: Buffer;
  if (change.status === "??") {
    output = diffUntrackedPath(repository, changedPath);
  } else if (state.head) {
    output = requireGit(repository, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", state.head, "--", changedPath], {
      env: { GIT_OPTIONAL_LOCKS: "0" },
      message: "Could not read project diff",
    });
  } else {
    const staged = runGitAt(repository, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--", changedPath], { GIT_OPTIONAL_LOCKS: "0" });
    if (staged.status !== 0) throw new ProjectGitError("git_diff_failed", `Could not read project diff: ${errorText(staged.stderr) || errorText(staged.stdout)}`, 409);
    const unstaged = runGitAt(repository, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--", changedPath], { GIT_OPTIONAL_LOCKS: "0" });
    if (unstaged.status !== 0) throw new ProjectGitError("git_diff_failed", `Could not read project diff: ${errorText(unstaged.stderr) || errorText(unstaged.stdout)}`, 409);
    output = Buffer.concat([staged.stdout, unstaged.stdout]);
  }
  return { path: changedPath, diff: output.toString("utf8") };
}

export function projectIsExplicitlyDeclared(project: ProjectRead, catalogPath: string): boolean {
  if (fs.existsSync(path.join(project.root, "project.yaml"))) return true;
  return (readProjectCatalog(catalogPath) ?? []).some(entry => entry.id === project.id);
}
