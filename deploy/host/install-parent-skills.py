#!/usr/bin/env python3
"""Link top-level ParentSkill skills into provider-native user directories.

Run on the T3 host after backing up existing skill directories. Existing entries
are never replaced; their names are reported so they can be reviewed separately.
"""

import argparse
import json
from pathlib import Path


def skill_roots(home: Path, settings: Path) -> list[Path]:
    roots = [
        home / ".agents/skills",  # Codex, Cursor, OpenCode
        home / ".claude/skills",
        home / ".gemini/config/skills",  # Antigravity
        home / ".grok/skills",
        home / ".kiro/skills",
    ]
    if settings.is_file():
        instances = json.loads(settings.read_text(encoding="utf-8")).get("providerInstances", {})
        for instance in instances.values():
            if not isinstance(instance, dict) or not instance.get("enabled"):
                continue
            if instance.get("driver") != "claudeAgent":
                continue
            configured_home = instance.get("config", {}).get("homePath")
            if isinstance(configured_home, str) and configured_home.strip():
                path = Path(configured_home).expanduser()
                if path.is_absolute():
                    roots.append(path / "skills")
    return list(dict.fromkeys(roots))


def install(source: Path, roots: list[Path], dry_run: bool = False) -> dict[Path, tuple[int, list[str]]]:
    skills = sorted(path for path in source.iterdir() if (path / "SKILL.md").is_file())
    if not skills:
        raise ValueError(f"No top-level skills found in {source}")
    results = {}
    for root in roots:
        created = 0
        conflicts = []
        for skill in skills:
            target = root / skill.name
            if target.is_symlink() and target.resolve() == skill.resolve():
                continue
            if target.exists() or target.is_symlink():
                conflicts.append(skill.name)
                continue
            if not dry_run:
                root.mkdir(parents=True, exist_ok=True)
                target.symlink_to(skill.resolve(), target_is_directory=True)
            created += 1
        results[root] = created, conflicts
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--source", type=Path)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    source = args.source or args.home / "workspace/wkzxy/ParentSkill"
    settings = args.settings or args.home / ".t3/userdata/settings.json"
    for root, (created, conflicts) in install(
        source, skill_roots(args.home, settings), args.dry_run
    ).items():
        print(f"{root}: {'would add' if args.dry_run else 'added'} {created}; preserved {len(conflicts)}")
        if conflicts:
            print(f"  existing: {', '.join(conflicts)}")


if __name__ == "__main__":
    main()
