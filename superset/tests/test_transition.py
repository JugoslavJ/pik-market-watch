"""Exercise deployment modes and failed backup/cutover behavior without live services."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
if not (ROOT / "scripts/deploy-stack.sh").exists():
    ROOT = Path("/repo")


class TransitionContracts(unittest.TestCase):
    def test_shell_assets_have_valid_syntax(self):
        for shell, file in [("bash", "scripts/deploy-stack.sh"),
                            ("bash", "scripts/superset-readiness.sh"),
                            ("bash", str(Path(__file__).resolve().parents[1] / "init.sh")),
                            ("bash", str(Path(__file__).resolve().parents[1] / "run-alert-checker.sh")),
                            ("sh", "scripts/lib/dashboard-stack.sh"),
                            ("sh", "db/backup.sh"), ("sh", "db/remote-restore.sh")]:
            result = subprocess.run([shell, "-n", str(ROOT / file)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "scripts/lib").mkdir(parents=True)
        (self.root / "config").mkdir()
        (self.root / "config/searches.json").write_text("{}")
        for name in ("deploy-stack.sh", "superset-readiness.sh", "lib/dashboard-stack.sh"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts" / name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *validate_viewer.py*) [ "${MOCK_FAIL_PARITY:-0}" = 0 ] || exit 44 ;;
  *'ps -q '*) echo container ;;
  'inspect '*) echo healthy ;;
esac
''')
        docker.chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.bin) + ":" + os.environ["PATH"],
                    "DEPLOY_DIR": str(self.root), "COMMAND_LOG": str(self.root / "commands")}
        for key in ("DASHBOARD_MODE", "COMPOSE_PROFILES", "COMPOSE_FILE", "SUPERSET_ROOT_URL", "SUPERSET_DOMAIN", "SUPERSET_COOKIE_SECURE"):
            self.env.pop(key, None)

    def tearDown(self):
        self.tmp.cleanup()

    def configure(self, mode):
        secrets = ["POSTGRES_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD", "POSTGRES_APP_PASSWORD",
                   "POSTGRES_REPORTING_PASSWORD", "POSTGRES_BACKUP_PASSWORD",
                   "SUPERSET_META_PASSWORD", "SUPERSET_ADMIN_PASSWORD", "SUPERSET_SECRET_KEY"]
        lines = [f"{key}=fixture-secret" for key in secrets]
        if mode:
            lines.append(f"DASHBOARD_MODE={mode}")
        lines.extend(["SUPERSET_BIND=127.0.0.1", "SUPERSET_DOMAIN=dashboard.example.com",
                      "SUPERSET_ROOT_URL=https://dashboard.example.com/", "SUPERSET_COOKIE_SECURE=true"])
        (self.root / ".env").write_text("\n".join(lines) + "\n")

    def run_deploy(self, *args):
        return subprocess.run(["bash", str(self.root / "scripts/deploy-stack.sh"), *args],
                              env=self.env, capture_output=True, text=True)

    def test_superset_preflight_checks_configuration(self):
        self.configure("superset")
        result = self.run_deploy("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "commands").read_text().strip(), "compose config --quiet")

    def test_existing_host_defaults_to_superset(self):
        self.configure(None)
        result = self.run_deploy("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "commands").read_text().strip(), "compose config --quiet")

    def test_public_bind_fails_before_any_docker_operation(self):
        self.configure("superset")
        file = self.root / ".env"
        file.write_text(file.read_text().replace("SUPERSET_BIND=127.0.0.1", "SUPERSET_BIND=0.0.0.0"))
        self.assertNotEqual(self.run_deploy("--check").returncode, 0)
        self.assertFalse((self.root / "commands").exists())

    def test_failed_viewer_parity_gate_prevents_publication(self):
        self.configure("superset")
        self.env["MOCK_FAIL_PARITY"] = "1"
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        commands = (self.root / "commands").read_text()
        self.assertIn("validate_viewer.py", commands)
        self.assertNotIn("superset-access --publish", commands)

    def test_deploy_builds_before_starting_and_checks_before_publication(self):
        self.configure("superset")
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = (self.root / "commands").read_text()
        self.assertIn("up -d --build db db-backup superset superset-alert-check", commands)
        self.assertLess(commands.index("compose build superset"), commands.index("up -d --build db db-backup superset"))
        self.assertLess(commands.index("benchmark_viewer.py"), commands.index("superset-access --publish"))

    def test_only_the_new_dashboard_profile_is_selected(self):
        self.configure("superset")
        command = '. scripts/lib/dashboard-stack.sh; configure_dashboard_stack; printf "%s|%s|" "$COMPOSE_FILE" "$COMPOSE_PROFILES"; dashboard_services'
        result = subprocess.run(["sh", "-c", command], cwd=self.root, env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "docker-compose.yml|superset|superset")

    def test_unsupported_modes_are_rejected_before_docker_operations(self):
        for mode in ("other", "parallel"):
            self.configure(mode)
            result = self.run_deploy("--check")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Only Superset is supported", result.stderr)
            self.assertFalse((self.root / "commands").exists())


class BackupContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for name in ("backups", "home", "bin"):
            (self.root / name).mkdir()
        (self.root / "home/state.json").write_text('{}')
        for name, body in {
            "pg_dump": 'for arg do target=$arg; done; printf valid > "$target"; [ "${FAIL_DUMP:-0}" = 0 ]',
            "pg_restore": 'for arg do target=$arg; done; [ "$(cat "$target")" = valid ]',
        }.items():
            file = self.root / "bin" / name
            file.write_text("#!/bin/sh\n" + body + "\n")
            file.chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.root / "bin") + ":" + os.environ["PATH"],
                    "BACKUP_DIR": str(self.root / "backups"), "SUPERSET_HOME": str(self.root / "home"),
                    "DASHBOARD_MODE": "superset",
                    "BACKUP_RETENTION_DAYS": "0", "SUPERSET_META_DB": "superset_meta"}

    def tearDown(self):
        self.tmp.cleanup()

    def backup(self, flag):
        return subprocess.run(["sh", str(ROOT / "db/backup.sh"), flag], env=self.env,
                              capture_output=True, text=True)

    def test_superset_backups_include_databases_and_home(self):
        result = self.backup("--once")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.backup("--check").returncode, 0)
        self.assertEqual(len(list((self.root / "backups").glob("*.dump"))), 2)
        self.assertEqual(len(list((self.root / "backups").glob("*.tar.gz"))), 1)

    def test_failed_dump_preserves_previous_archive_and_cleans_own_partial(self):
        self.assertEqual(self.backup("--once").returncode, 0)
        before = {p.name: p.read_bytes() for p in (self.root / "backups").glob("*.dump")}
        other = self.root / "backups/another-job.partial"
        other.write_text("keep")
        self.env["FAIL_DUMP"] = "1"
        self.assertNotEqual(self.backup("--once").returncode, 0)
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.root / "backups").glob("*.dump")})
        self.assertTrue(other.exists())
        self.assertFalse(list((self.root / "backups").glob("*.partial.*")))

    def test_corrupted_home_archive_fails_health_even_with_fresh_dumps(self):
        self.assertEqual(self.backup("--once").returncode, 0)
        next((self.root / "backups").glob("*.tar.gz")).write_text("corrupt")
        self.assertNotEqual(self.backup("--check").returncode, 0)


if __name__ == "__main__":
    unittest.main()
