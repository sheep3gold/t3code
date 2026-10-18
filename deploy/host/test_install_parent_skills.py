import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


MODULE_PATH = Path(__file__).with_name("install-parent-skills.py")
spec = importlib.util.spec_from_file_location("install_parent_skills", MODULE_PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallParentSkillsTest(unittest.TestCase):
    def test_installs_only_top_level_skills_and_preserves_existing_entries(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            source = home / "ParentSkill"
            for name in ("review", "deploy"):
                skill = source / name
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
            nested = source / "claude/skills/snapshot"
            nested.mkdir(parents=True)
            (nested / "SKILL.md").write_text("---\nname: snapshot\n---\n")

            global_root = home / ".agents/skills"
            existing = global_root / "review"
            existing.mkdir(parents=True)
            (existing / "SKILL.md").write_text("existing content")
            custom_home = home / ".claude-custom"
            settings = home / "settings.json"
            settings.write_text(json.dumps({"providerInstances": {
                "custom": {"driver": "claudeAgent", "enabled": True,
                           "config": {"homePath": str(custom_home)}},
                "disabled": {"driver": "claudeAgent", "enabled": False,
                             "config": {"homePath": str(home / ".claude-disabled")}},
            }}))
            roots = installer.skill_roots(home, settings)
            self.assertIn(custom_home / "skills", roots)
            self.assertNotIn(home / ".claude-disabled/skills", roots)

            preview = installer.install(source, roots, dry_run=True)
            self.assertFalse((global_root / "deploy").exists())
            self.assertEqual(preview[global_root], (1, ["review"]))

            result = installer.install(source, roots)
            self.assertEqual(result[global_root], (1, ["review"]))
            self.assertEqual((existing / "SKILL.md").read_text(), "existing content")
            self.assertEqual((global_root / "deploy").resolve(), source / "deploy")
            self.assertEqual((custom_home / "skills/review").resolve(), source / "review")
            self.assertFalse((custom_home / "skills/snapshot").exists())
            self.assertEqual(installer.install(source, roots)[global_root], (0, ["review"]))

    def test_fails_when_source_has_no_skills(self):
        with TemporaryDirectory() as directory:
            source = Path(directory)
            with self.assertRaisesRegex(ValueError, "No top-level skills"):
                installer.install(source, [source / "target"])


if __name__ == "__main__":
    unittest.main()
