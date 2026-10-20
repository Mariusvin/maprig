#!/usr/bin/env python3
"""Create independent source copies and evidence-backed OpenRig project scaffolds."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone


PRUNE = {".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".cache", ".local", ".runtime", ".worktrees", "exhaust"}


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=check, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def digest(file: Path) -> str:
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def within(root: Path, child: Path) -> bool:
    return child == root or root in child.parents


def ignored_private(name: str) -> bool:
    return (name.startswith(".env") and not any(x in name for x in ("example", "sample", "template"))) or name in {".credentials.json", "auth.json"}


def source_files(source: Path, repo: bool, nested_roots: list[Path] | None = None) -> tuple[list[str], list[str]]:
    excluded = []
    if repo:
        result = git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        entries = {os.fsdecode(raw).replace("\\", "/") for raw in result.stdout.split(b"\0") if raw}
        # Room state is often deliberately ignored by the application repository.
        for name in (".maproom",):
            folder = source / name
            if folder.is_dir():
                for root, dirs, files in os.walk(folder, followlinks=False):
                    dirs[:] = [d for d in dirs if d not in PRUNE]
                    entries.update((Path(root) / file).relative_to(source).as_posix() for file in files)
        # Report ignored top-level working assets without enumerating their contents.
        for item in source.iterdir():
            if item.name == ".git":
                continue
            if git(source, "check-ignore", "--quiet", "--", item.name, check=False).returncode == 0:
                excluded.append(item.name)
    else:
        entries = set()
        for root, dirs, files in os.walk(source, followlinks=False):
            kept = []
            for name in dirs:
                child = Path(root) / name
                if name in PRUNE or child.is_symlink() or child.resolve() in (nested_roots or []):
                    excluded.append(child.relative_to(source).as_posix())
                else:
                    kept.append(name)
            dirs[:] = kept
            for name in files:
                rel = (Path(root) / name).relative_to(source).as_posix()
                if ignored_private(name):
                    excluded.append(rel)
                else:
                    entries.add(rel)
    filtered = []
    for rel in entries:
        if any(within(child, source / rel) for child in nested_roots or []):
            excluded.append(rel)
        else:
            filtered.append(rel)
    return sorted(filtered), sorted(set(excluded))


def write_text(file: Path, text: str) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf8", newline="\n")


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def scaffold(target: Path, entry: dict, room: dict | None, receipt: dict) -> None:
    project_id = room["project"]["id"] if room else entry["id"]
    name = room["project"]["name"] if room else entry["name"]
    purpose = room["project"].get("summary", "") if room else entry.get("purpose", "Existing local project copied for continued work in OpenRig.")
    generated = target / ".openrig-project"
    generated.mkdir()
    write_text(generated / "SPEC.md", f"---\nintent: {yaml_string(purpose)}\n---\n\n# {name}\n\n{purpose}\n\nThe application source remains at this project's root. Read its original instructions and project documentation before changing it.\n\n## Migration position\n\nThis is an independent working copy of `{receipt['source']}`. Original files remain unchanged. Git commits created here belong to this copy. Runtime dependencies and ignored local assets are listed in `copy-receipt.json`; install or restore required assets before running the application.\n\nImported planning progress is retained as authored evidence, independently of native execution proof. No agent or application has been launched by migration.\n")
    manifest = target / "project.yaml"
    if manifest.exists():
        raise RuntimeError(f"Existing project.yaml requires an explicit adaptation: {target}")
    write_text(manifest, f"schema: openrig.project/v0alpha1\nkind: project\nmetadata:\n  id: {yaml_string(project_id)}\n  name: {yaml_string(name)}\ninstall:\n  intent: .openrig-project/SPEC.md\n  context: []\n  skills: []\nsource:\n  root: .\nmissions:\n  root: .openrig-project/missions\n")
    if not (target / "SPEC.md").exists() and not (target / "README.md").exists():
        write_text(target / "SPEC.md", f"# {name}\n\n{purpose}\n\nSee `.openrig-project/SPEC.md` for the copied project's working context.\n")
    if room:
        project = room["project"]
        graphs = {g["id"]: g for g in project["graphs"]}
        root_graph = graphs[project["rootGraphId"]]
    else:
        timestamp = receipt["copiedAt"]
        tasks = entry.get("tasks") or [
            {"title": "Verify the copied project setup", "summary": "Follow the preserved project setup instructions in this copy and record a passing local smoke check. Application behavior has not been revalidated by migration."},
            {"title": "Select the next documented deliverable", "summary": "Inspect the preserved roadmap, source instructions and current Git changes. Define the next concrete delivery with acceptance evidence."},
        ]
        nodes = [{"id": f"{project_id}-task-{i + 1}", "title": t["title"], "summary": t["summary"], "status": "planned", "progress": 0,
                  "position": {"x": i * 340, "y": 180}, "dependsOn": [], "references": []} for i, t in enumerate(tasks)]
        project = {"id": project_id, "name": name, "summary": purpose + " New adoption tasks start at 0%; application completion has not been inferred.",
                   "rootGraphId": f"{project_id}-root", "graphs": [{"id": f"{project_id}-root", "level": 1, "title": name, "nodes": nodes}], "updatedAt": timestamp}
        write_text(target / "planning.json", json.dumps({"version": 1, "project": project}, indent=2, ensure_ascii=False) + "\n")
        graphs = {g["id"]: g for g in project["graphs"]}
        root_graph = graphs[project["rootGraphId"]]
    mapping = []

    def descendants(node: dict, graph: dict):
        yield node, graph
        if node.get("childGraphId"):
            child = graphs[node["childGraphId"]]
            for item in child["nodes"]:
                yield from descendants(item, child)

    for milestone in root_graph["nodes"]:
        mission_id = milestone["id"]
        mission = generated / "missions" / mission_id
        nodes = list(descendants(milestone, root_graph))
        slices = []
        for node, graph in nodes:
            slice_id = node["id"]
            slice_dir = mission / "slices" / slice_id
            summary = node.get("summary") or node["title"]
            write_text(slice_dir / "SPEC.md", f"---\nid: {yaml_string(slice_id)}\nmission: {yaml_string(mission_id)}\nstatus: planned\nstage: spec\nimported-status: {yaml_string(node['status'])}\nimported-progress: {node['progress']}\n---\n\n# {node['title']}\n\n## Intent\n\n{summary}\n\n## Mini-requirements\n\n1. Preserve the imported task contract and verify its outcome in this copy before claiming native execution proof.\n\n## Proof contract\n\n- [ ] Review the preserved task evidence against this copy's current source.\n\n## Imported conclusion\n\n{node.get('conclusion') or 'No conclusion recorded.'}\n\n## Planning identity\n\nGraph `{graph['id']}`, level {graph['level']}. Authored progress: {node['progress']}%, status `{node['status']}`. Prerequisites: {', '.join(node.get('dependsOn', [])) or 'none at this graph level'}. The original graph remains the authority for dependency and level navigation.\n")
            local_deps = [d for d in node.get("dependsOn", []) if any(n["id"] == d for n, _ in nodes)]
            write_text(slice_dir / "slice.yaml", f"schema: openrig.slice/v0alpha1\nkind: slice\nmetadata:\n  id: {yaml_string(slice_id)}\ncomposition:\n  mission: ../../mission.yaml\nexecution:\n  depends_on: {json.dumps(local_deps)}\n")
            write_text(slice_dir / "PROGRESS.md", "# Execution verification\n\n- [ ] Validate the imported contract and current source in this independent copy.\n")
            slices.append(f"    - {{ ref: slices/{slice_id}/slice.yaml, order: {len(slices) + 1}, active: false }}")
            mapping.append({"nodeId": node["id"], "graphId": graph["id"], "level": graph["level"], "mission": mission_id,
                            "slice": slice_id, "status": node["status"], "progress": node["progress"]})
        write_text(mission / "SPEC.md", f"---\nid: {yaml_string(mission_id)}\nstatus: planned\nintent: {yaml_string(milestone['title'])}\n---\n\n# {milestone['title']}\n\n{milestone.get('summary', '')}\n\nImported planning progress: {milestone['progress']}%. Native execution is staged as planned until work is deliberately picked up.\n")
        write_text(mission / "mission.yaml", "schema: openrig.mission/v0alpha1\nkind: mission\nmetadata:\n  id: " + yaml_string(mission_id) + "\nstatus: planned\ncomposition:\n  slices:\n" + "\n".join(slices) + "\n")
    write_text(generated / "node-mapping.json", json.dumps(mapping, indent=2) + "\n")
    write_text(generated / "copy-receipt.json", json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    write_text(generated / "COMMIT-WORKFLOW.md", f"# Local commits\n\nOpen the Changes view for `{project_id}` in OpenRig. Review the changed files and their diffs, select paths, write a commit message and create a local commit. The repository is this copy's root. No push to the original is configured.\n\nThe Git author is inherited from the original repository's resolved user identity where available. Missing identity is reported rather than invented.\n")
    # This small file provides a concrete, reviewable UI commit checkpoint.
    write_text(target / "OPENRIG_COPY.md", f"# {name}: independent OpenRig copy\n\nCopied from `{receipt['source']}` at {receipt['copiedAt']}.\n\nProject setup and migration evidence are in `.openrig-project/`. The original project has not been modified.\n")


def copy_project(entry: dict, destination: Path) -> dict:
    source = Path(entry["source"]).resolve(strict=True)
    destination = destination.resolve()
    if within(source, destination):
        raise RuntimeError("Copy destination must not be inside the source project")
    project_id = entry["id"]
    if not project_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for c in project_id) or project_id[0] in ".-":
        raise RuntimeError("Invalid project ID")
    target = destination / entry.get("relativeTarget", project_id)
    if not within(destination, target.resolve()):
        raise RuntimeError("Copy target escapes destination")
    if target.exists():
        raise RuntimeError(f"Destination already exists; refusing to overwrite: {target}")
    if any((source / name).exists() for name in ("project.yaml", ".openrig-project", "OPENRIG_COPY.md", "planning.json")):
        raise RuntimeError(f"Reserved setup path already exists in {source}; requires explicit handling")
    repo = git(source, "rev-parse", "--show-toplevel", check=False)
    is_repo = repo.returncode == 0 and Path(os.fsdecode(repo.stdout).strip()).resolve() == source
    nested_roots = [Path(value).resolve() for value in entry.get("nestedRoots", [])]
    entries, excluded = source_files(source, is_repo, nested_roots)
    room_file = source / ".maproom" / "project.json"
    room = json.loads(room_file.read_text(encoding="utf-8-sig")) if room_file.exists() else None
    if room and room["project"]["id"] != project_id:
        raise RuntimeError("Maproom project ID must be preserved in the copy")
    destination.mkdir(parents=True, exist_ok=True)
    if is_repo:
        target.parent.mkdir(parents=True, exist_ok=True)
        clone = subprocess.run(["git", "clone", "--no-local", "--no-checkout", str(source), str(target)], capture_output=True)
        if clone.returncode:
            raise RuntimeError(f"Git copy failed for {source}: {os.fsdecode(clone.stderr)[-1000:]}")
        git(target, "read-tree", "HEAD", check=False)
        git(target, "remote", "set-url", "--push", "origin", "DISABLED")
    else:
        target.mkdir()
        git(target, "init", "--initial-branch=main")
    if nested_roots:
        exclude = target / ".git" / "info" / "exclude"
        with exclude.open("a", encoding="utf8") as stream:
            stream.write("\n# Independently migrated nested projects\n")
            for nested_root in nested_roots:
                stream.write("/" + nested_root.relative_to(source).as_posix() + "/\n")
    identity = {}
    for key in ("user.name", "user.email"):
        value = git(source, "config", "--get", key, check=False).stdout.strip()
        if value:
            git(target, "config", key, os.fsdecode(value))
            identity[key] = os.fsdecode(value)
    for key in ("core.autocrlf", "core.eol", "core.filemode", "core.symlinks"):
        value = git(source, "config", "--get", key, check=False).stdout.strip()
        if value:
            git(target, "config", key, os.fsdecode(value))
    copied, missing, external, nested = [], [], [], []
    for rel in entries:
        file = source / rel
        if not file.exists():
            missing.append(rel)
            continue
        actual = file.resolve()
        if not within(source, actual):
            external.append(rel)
            continue
        if file.is_dir():
            nested.append(rel)
            continue
        out = target / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        before = digest(file)
        shutil.copy2(file, out, follow_symlinks=True)
        after = digest(out)
        if before != after or digest(file) != before:
            raise RuntimeError(f"Source changed or copy mismatch: {source / rel}")
        copied.append({"path": rel, "sha256": after, "bytes": out.stat().st_size})
    head_result = git(source, "rev-parse", "--verify", "HEAD", check=False) if is_repo else None
    receipt = {"version": 1, "source": str(source), "destination": str(target), "copiedAt": datetime.now(timezone.utc).isoformat(),
               "git": is_repo, "originalHead": os.fsdecode(head_result.stdout).strip() if head_result and head_result.returncode == 0 else None,
               "identityConfigured": bool(identity.get("user.name") and identity.get("user.email")), "files": copied, "fileCount": len(copied),
               "bytes": sum(f["bytes"] for f in copied), "excludedIgnoredRoots": excluded, "deletedSourcePaths": missing,
               "externalLinksNotCopied": external, "nestedProjectsNotExpanded": nested, "planningKind": "maproom" if room else "openrig"}
    large_assets = [f["path"] for f in copied if not is_repo and f["bytes"] >= 64 * 1024 * 1024]
    receipt["localAssetsExcludedFromNewGitIndex"] = large_assets
    if large_assets:
        with (target / ".git" / "info" / "exclude").open("a", encoding="utf8") as stream:
            stream.write("\n# Large local assets copied outside the new source index\n")
            for rel in large_assets:
                stream.write("/" + rel.replace("[", "\\[").replace("*", "\\*").replace("?", "\\?") + "\n")
    scaffold(target, entry, room, receipt)
    if room:
        copied_room = json.loads((target / ".maproom" / "project.json").read_text(encoding="utf-8-sig"))
        if copied_room != room:
            raise RuntimeError("Migrated Maproom room differs from the source")
        git(target, "add", "--force", "--", ".maproom")
    return {"id": project_id, "name": room["project"]["name"] if room else entry["name"], "source": str(source), "destination": str(target),
            "planningKind": receipt["planningKind"], "files": len(copied), "bytes": receipt["bytes"], "externalLinksNotCopied": external, "nestedProjectsNotExpanded": nested}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text(encoding="utf-8-sig"))
    report = {"destination": str(args.destination.resolve()), "copied": [], "errors": [], "exclusions": inventory.get("exclusions", [])}
    for entry in inventory["projects"]:
        try:
            result = copy_project(entry, args.destination)
            report["copied"].append(result)
            print(json.dumps({"copied": result["id"], "files": result["files"], "bytes": result["bytes"]}), flush=True)
        except Exception as error:
            report["errors"].append({"source": entry["source"], "error": str(error)})
            print(json.dumps({"source": entry["source"], "error": str(error)}), flush=True)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
