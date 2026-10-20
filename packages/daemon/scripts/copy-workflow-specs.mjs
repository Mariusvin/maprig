import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";

const sourceDir = join(process.cwd(), "src", "builtins", "workflow-specs");
const targetDir = join(process.cwd(), "dist", "builtins", "workflow-specs");
const workflowSpecExtensions = new Set([".yaml", ".yml"]);

const localAgentTarget = join(process.cwd(), 'assets', 'local-agents');
mkdirSync(localAgentTarget, { recursive: true });
for (const file of ['local-agent-account-store.mjs', 'local-agent-accounts.mjs', 'local-agent-brain-worker.mjs']) {
  copyFileSync(join(process.cwd(), '..', '..', 'scripts', file), join(localAgentTarget, file));
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

if (!existsSync(sourceDir)) {
  process.exit(0);
}

for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!workflowSpecExtensions.has(extname(entry.name).toLowerCase())) continue;
  copyFileSync(join(sourceDir, entry.name), join(targetDir, entry.name));
}
