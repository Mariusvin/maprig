# Linked Maproom planning graphs

OpenRig's Project page can display a Maproom project as a linked plan. The source
is its existing `.maproom/project.json` file, using the version 1 room envelope.
No task is marked complete, no mission is activated and no agent is launched by
linking or viewing a plan.

The first migration stage preserves every graph, node ID, dependency, position,
status, authored progress value, reference and completion conclusion. It supports
all four planning levels. The node inspector and task index provide keyboard
navigation, and graph breadcrumbs provide navigation back to parent levels.
Arrows point from prerequisites to dependent tasks. Progress values come directly
from Maproom; OpenRig does not substitute its mission proof percentages or
recalculate them from a different set of tasks.

## Register a local project

After building the daemon, from the repository root run:

```sh
node scripts/link-maproom.mjs --project-root /path/to/project --workspace /path/to/openrig/workspace
```

The script validates the source, then adds its identity and relative root to
`workspace.yaml`. Existing entries and YAML comments remain. Repeating the same
link changes nothing. An ID or root collision stops without writing. It does not
change the source project or require an OpenRig mission scaffold in that project.
The source file must resolve inside the registered project directory.
Concurrent helper registrations use an exclusive workspace lock. If another
editor changes the catalog before replacement, linking aborts and can be retried.
A helper interrupted before cleanup can leave `.openrig-maproom-link.lock`;
inspect its recorded process ID before removing a stale lock.

If `workspace.catalog_path` is customized, register the entry in that catalog
instead. The helper above targets the default `workspace.yaml` catalog only.

Open `/project/plan?project=<id>`. The Project landing page shows a linked plan
when one exists; its Execution workspace link opens the existing native mission
view. Graph and selected-node addresses can be bookmarked:

```text
/project/plan?project=<id>&graph=<graph-id>&node=<node-id>
```

The view reads the source on opening, on Refresh and every ten seconds while
visible. It displays the source update time, read time, location and content
digest. A missing or invalid source produces an error rather than an empty plan
or a success state. Last loaded content may remain visible beside that error.
Planning reads inherit the daemon's existing trusted-network read boundary,
like the native scope source views. The operator bearer protects write integrity,
not confidentiality of read endpoints. Keep this local installation published
on loopback; do not expose it as a public plan-sharing service.

## Isolated Docker installation on Windows

Mount only the existing `.maproom` directory into the persistent workspace,
read only. Keep the existing container's loopback port, authentication, capability
restrictions, read-only root filesystem and named home volume. The optional
`docker/maproom/compose.override.yaml` adds this mount to the existing `openrig`
service. Set these variables in the launch environment:

```powershell
$env:MAPROOM_ROOM_PATH = 'C:/path/to/project/.maproom'
$env:MAPROOM_PROJECT_ID = '<actual-project-id>'
docker compose --project-directory <launch-directory> -f <launch-directory>/compose.yaml -f docker/maproom/compose.override.yaml up -d --no-build
docker exec -w /opt/openrig openrig-isolated node scripts/link-maproom.mjs --project-root /home/node/.openrig/workspace/projects/<actual-project-id> --workspace /home/node/.openrig/workspace
```

Use an image built from this checkout; an older image lacks the planning endpoint
and viewer. Preserve the source archive and build instructions used by the launch
directory when rebuilding. Store the mount values with the local launch settings
so future compose invocations use the same directory. The entire directory is
mounted because Maproom atomically replaces `project.json`; binding the single
file can leave the container reading an old inode.

No media, models, provider credentials or application runtime directories need to
be mounted. A container can inspect this plan without a logged-in agent runtime.

## Migration boundary and next stages

This is a live planning integration, with Maproom retaining write ownership.
Use the Maproom CLI to edit tasks and record evidence. There is no bidirectional
write synchronization and no conversion of planning statuses into native mission
proof or queue items. Director chat history and agent sessions are not imported.

A later execution migration can map selected deliverables into native missions
and slices using explicit ID mappings, provenance and acceptance rules. Keep
the linked original plan available while validating those mappings; do not
flatten four levels or infer completion from a different progress calculation.

## Verification

The planning route tests check byte-preserving reads, changed-source detection,
identity validation, broken links and source containment. The registration test
checks additive linking, repeatability and collision refusal. UI tests check
level navigation, authored percentages, prerequisite navigation, unsafe-link
handling and missing-graph recovery. Browser acceptance additionally checks the
real graph, its inspector, deep navigation, narrow layouts and the mounted source.
