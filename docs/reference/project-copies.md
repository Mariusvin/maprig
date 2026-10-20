# Independent project copies and local commits

Projects can be copied into a separate working directory, registered with
OpenRig, and committed through the Project changes page. The source repositories
and their current application processes remain independent of the copies.

## Copy contract

`scripts/copy-projects.py` consumes an inventory with a `projects` array. Each
entry names `source`, `id`, `name` and optional `relativeTarget`, `purpose`, `tasks`
and `nestedRoots`. The destination must be outside every source and an existing
target is never overwritten.

For Git projects the copy uses an independent clone without shared object
alternates, then copies the current tracked and non-ignored untracked source.
This preserves the existing commit history and current source edits, including
working-tree deletions. The copy's origin push URL is disabled. For folders
without Git, a new local repository is initialized. The resolved existing Git
author and line-ending configuration are retained where available; missing
identity remains explicit.

Ignored application dependencies, caches, model assets, generated worktrees and
local credentials are not a second runtime installation. The source-file receipt
lists copied file hashes, ignored root entries, deleted paths, external links
and independently handled nested projects. Nested projects can retain their
original relative directory layout and are excluded from the parent's Git index.
For a folder gaining Git for the first time, pre-existing assets of 64 MiB or
more are copied but excluded from its initial source index and listed in the
receipt. This keeps multi-gigabyte local firmware images out of routine source
status and commit operations; it does not remove them from the working copy.
External source links are recorded instead of silently following them into a
different project.

Every copy receives `project.yaml`, `.openrig-project/SPEC.md`, native planned
missions and slices, a node mapping, and a copy receipt. Existing files with these
reserved names stop the operation for explicit handling rather than being
overwritten. Generated work contracts describe future validation in the copy;
they do not assert that an application has been rebuilt or tested.

## Preserve Maproom plans

Existing `.maproom` state and local room evidence are copied. The version 1 room
retains all authored graph levels, IDs, dependencies, statuses, positions,
percentages, references and conclusions. The copied room is added to the copy's
Git index even if the original repository ignored it, so future planning changes
can be committed locally.

Each original node maps to a native slice, grouped under the root milestone's
mission. `node-mapping.json` preserves the original graph and level identity.
Native execution proof starts unverified; imported planning progress continues
to appear in the layered planning view. There is no inference that an imported
100% task passed OpenRig's independent proof contract.

Projects without a Maproom room receive native `planning.json` and initial
adoption tasks with zero progress. Their project purpose and acceptance criteria
should come from their preserved documentation. An empty saved workspace keeps
its unknown scope explicit instead of gaining a fictional application roadmap.

## Register the copies

After building the daemon, register the completed copy report:

```sh
python scripts/copy-projects.py --inventory inventory.json --destination /path/to/copies --report copy-report.json
node scripts/register-project-copies.mjs --report copy-report.json --workspace /path/to/workspace --mount-root /path/to/copies
```

The registration helper checks every plan and independent Git repository before
writing the catalog. It preserves existing catalog entries, uses the catalog
lock, and refuses identity conflicts. An existing read-only project pointer can
be replaced only when `replacements` explicitly names its ID and old root, and
the old and new authored plans compare equal. Rerunning a successful registration
does not duplicate entries.

For Docker, mount the copied-project directory read/write at the same persistent
location used by the catalog. Keep the original projects unmounted. The helper
adds only the exact registered copied roots to the daemon user's protected Git
`safe.directory` configuration, which is needed when a Windows host owns bind
mount files. Keep the original daemon's loopback binding and bearer settings.

## Make a commit in the interface

Open a project plan and select **Project changes**. The page shows its branch,
current commit, changed files and resolved Git author. Select a filename to read
its diff, tick the paths to include, and enter a commit message. Supply the
existing operator token if bearer authentication is enabled. The token field is
used in memory for the action and does not save a new credential preference.

**Commit selected files** creates a local commit in that project's copied
repository. It does not push. The write route verifies the observed commit and
content fingerprint, so a stale view must be refreshed. Selected paths are
committed through a temporary index; unrelated previously staged paths remain
staged. Git hooks remain enabled. Missing identity or a failed hook is reported
as a failed operation, with no fabricated commit success.

The copy is a working source snapshot rather than proof that all original
applications can already run on the new paths. Dependency installation,
ignored runtime assets, external source links and application-specific checks
remain visible in the project context and receipts.
