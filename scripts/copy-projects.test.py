import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("project_copies", Path(__file__).with_name("copy-projects.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()


class CopyProjectsTests(unittest.TestCase):
    def test_unborn_repository_has_no_invented_original_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "empty"
            source.mkdir()
            git(source, "init", "--initial-branch=main")
            module.copy_project({"source": str(source), "id": "empty", "name": "Empty"}, base / "copies")
            receipt = json.loads((base / "copies/empty/.openrig-project/copy-receipt.json").read_text(encoding="utf8"))
            self.assertIsNone(receipt["originalHead"])

    def test_repository_history_current_changes_and_maproom_are_independent(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "original"
            source.mkdir()
            git(source, "init", "--initial-branch=main")
            git(source, "config", "user.name", "Test Author")
            git(source, "config", "user.email", "test@example.invalid")
            (source / "README.md").write_text("# Existing project\n", encoding="utf8")
            (source / "delete.txt").write_text("deleted in working state\n", encoding="utf8")
            (source / ".gitignore").write_text("node_modules/\n.maproom/\n", encoding="utf8")
            git(source, "add", ".")
            git(source, "commit", "-m", "Initial source")
            original_head = git(source, "rev-parse", "HEAD")
            (source / "README.md").write_text("# Existing project\nUncommitted edit\n", encoding="utf8")
            (source / "delete.txt").unlink()
            (source / "new.txt").write_text("untracked\n", encoding="utf8")
            (source / "node_modules").mkdir()
            (source / "node_modules" / "cache.txt").write_text("not copied", encoding="utf8")
            (source / ".maproom").mkdir()
            room = {"version": 1, "project": {"id": "example", "name": "Example", "rootGraphId": "root", "graphs": [
                {"id": "root", "title": "Roadmap", "level": 1, "nodes": [{"id": "task-a", "title": "An existing task", "summary": "Retain measured progress", "progress": 44,
                 "status": "in_progress", "position": {"x": 20, "y": 30}, "dependsOn": [], "references": []}]}]}}
            (source / ".maproom" / "project.json").write_text(json.dumps(room), encoding="utf8")
            before = git(source, "status", "--porcelain=v1", "--untracked-files=all")
            result = module.copy_project({"source": str(source), "id": "example", "name": "Example"}, base / "copies")
            target = Path(result["destination"])
            self.assertEqual(git(target, "rev-parse", "HEAD"), original_head)
            self.assertEqual(git(source, "status", "--porcelain=v1", "--untracked-files=all"), before)
            self.assertEqual(json.loads((target / ".maproom" / "project.json").read_text(encoding="utf8")), room)
            self.assertFalse((target / "node_modules").exists())
            self.assertFalse((target / "delete.txt").exists())
            self.assertTrue((target / "new.txt").exists())
            self.assertFalse((target / ".git" / "objects" / "info" / "alternates").exists())
            self.assertEqual(git(target, "remote", "get-url", "--push", "origin"), "DISABLED")
            (target / "new.txt").write_text("changed in copy", encoding="utf8")
            self.assertEqual((source / "new.txt").read_text(encoding="utf8"), "untracked\n")
            mapping = json.loads((target / ".openrig-project" / "node-mapping.json").read_text(encoding="utf8"))
            self.assertEqual(mapping[0]["progress"], 44)
            self.assertTrue((target / ".openrig-project" / "missions" / "task-a" / "slices" / "task-a" / "SPEC.md").exists())
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                module.copy_project({"source": str(source), "id": "example", "name": "Example"}, base / "copies")

    def test_non_repository_receives_native_setup_and_no_fabricated_progress(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "notes"
            source.mkdir()
            (source / "notes.txt").write_text("Project notes", encoding="utf8")
            (source / ".env").write_text("PRIVATE=example", encoding="utf8")
            result = module.copy_project({"source": str(source), "id": "notes", "name": "Notes", "purpose": "A local notes project."}, base / "copies")
            target = Path(result["destination"])
            self.assertTrue((target / ".git").is_dir())
            self.assertFalse((target / ".maproom").exists())
            self.assertFalse((target / ".env").exists())
            plan = json.loads((target / "planning.json").read_text(encoding="utf8"))["project"]
            self.assertTrue(all(n["progress"] == 0 for g in plan["graphs"] for n in g["nodes"]))
            self.assertIn("source:\n  root: .", (target / "project.yaml").read_text(encoding="utf8"))
            self.assertTrue((target / "SPEC.md").exists())


if __name__ == "__main__":
    unittest.main()
