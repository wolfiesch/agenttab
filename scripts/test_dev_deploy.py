#!/usr/bin/env python3
"""Deterministic tests for the tightened AgentTab development deployment workflow."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.dev_deploy import (
    DeployError,
    check_platform_reload_support,
    clean_version,
    compute_bundle_digest,
    deploy,
    load_identity,
    parse_args,
    poll_readiness,
    repo_root,
    resolve_target_dir,
    rollback,
    validate_sibling_paths,
    validate_target,
    validate_timeout,
    verify_bundle,
    verify_installed_bytes,
    write_receipt_atomic,
)

IDENTITY_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsygX+numOVow/Ue5WsMa7ODAjkjCXGUSskjE1UPBrADmDHlWJ/QPal51nKFZDTt3cDgnXG36R+WP"
    "6aufLES3qkkL91EvtZ1r89Gytyq8wwaJOl+4I/wKk979ri0fKX3rdvVMvs4KmK/RWIfpqWT5kl/7wMYzTN0qYsOpFU3mV/E6DKuvK0cIInjiw2SOj4nDbW"
    "mmTPUv9Q01YBzYrnO5ixoSrGzGBM+rxQFAifxFOmCKtKiWz402TL+cCaNSuQhN1NZPXOX36Wbur9sGAB2fRZunfnTLR6F4++4J1ZW12GJzvN0r+rtyHrCb"
    "JqXPf27REf91J8SJ0UjiWYNQnXTkIwIDAQAB"
)


def create_mock_extension_bundle(
    bundle_dir: Path,
    key: str = IDENTITY_KEY,
    version: str = "2.0.0",
    version_name: str = "2.0.0-rc.1",
    permissions: list[str] | None = None,
    optional_permissions: list[str] | None = None,
    host_permissions: list[str] | None = None,
    forbidden_key: str | None = None,
) -> None:
    bundle_dir.mkdir(parents=True, exist_ok=True)
    manifest_data = {
        "manifest_version": 3,
        "name": "AgentTab Development",
        "version": version,
        "version_name": version_name,
        "key": key,
        "permissions": permissions if permissions is not None else [
            "alarms",
            "debugger",
            "nativeMessaging",
            "storage",
            "tabGroups",
            "tabs",
        ],
        "optional_permissions": optional_permissions if optional_permissions is not None else ["scripting"],
        "host_permissions": host_permissions if host_permissions is not None else ["<all_urls>"],
    }
    if forbidden_key:
        manifest_data[forbidden_key] = True

    (bundle_dir / "manifest.json").write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")
    (bundle_dir / "background.js").write_text("console.log('bg');\n", encoding="utf-8")
    (bundle_dir / "popup.html").write_text("<!DOCTYPE html><html><body>popup</body></html>\n", encoding="utf-8")
    (bundle_dir / "popup.css").write_text("body { margin: 0; }\n", encoding="utf-8")
    (bundle_dir / "popup.js").write_text("console.log('pop');\n", encoding="utf-8")
    (bundle_dir / "wake.html").write_text("<!DOCTYPE html><html><body>wake</body></html>\n", encoding="utf-8")
    (bundle_dir / "wake.js").write_text("console.log('wake');\n", encoding="utf-8")

    icons_dir = bundle_dir / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (icons_dir / f"icon{size}.png").write_bytes(f"icon_{size}".encode("utf-8"))


class DevDeployTests(unittest.TestCase):
    def test_timeout_validation(self) -> None:
        self.assertEqual(validate_timeout(90.0), 90.0)
        self.assertEqual(validate_timeout(1), 1.0)
        with self.assertRaises(DeployError):
            validate_timeout(float("nan"))
        with self.assertRaises(DeployError):
            validate_timeout(float("inf"))
        with self.assertRaises(DeployError):
            validate_timeout(0.0)
        with self.assertRaises(DeployError):
            validate_timeout(-5.0)

    def test_version_traversal_rejection(self) -> None:
        with self.assertRaises(DeployError) as ctx:
            clean_version("../../etc")
        self.assertIn("Invalid version format", str(ctx.exception))

        with self.assertRaises(DeployError):
            clean_version("foo/bar")

        with self.assertRaises(DeployError):
            clean_version("..")

        self.assertEqual(clean_version("v2.0.0-rc.1"), "2.0.0-rc.1")
        self.assertEqual(clean_version("2.0.0"), "2.0.0")

    def test_hostile_path_rejections(self) -> None:
        root = repo_root()
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "source"
            create_mock_extension_bundle(src)

            # 1. Symlink target rejected
            symlink_target = tmp / "sym_target"
            real_target = tmp / "real_target"
            create_mock_extension_bundle(real_target)
            os.symlink(real_target, symlink_target)
            with self.assertRaises(DeployError) as ctx:
                validate_target(symlink_target, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            self.assertIn("cannot be a symbolic link", str(ctx.exception))

            # 2. Symlink parent component in target rejected
            symlink_parent = tmp / "sym_parent"
            real_parent = tmp / "real_parent"
            real_parent.mkdir()
            os.symlink(real_parent, symlink_parent)
            child_target = symlink_parent / "ext"
            create_mock_extension_bundle(real_parent / "ext")
            with self.assertRaises(DeployError) as ctx:
                validate_target(child_target, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            self.assertIn("symbolic link component", str(ctx.exception))

            # 3. System root and user home rejected
            with self.assertRaises(DeployError):
                validate_target(Path("/"), root=root, source_dir=src, expected_key=IDENTITY_KEY)
            with self.assertRaises(DeployError):
                validate_target(Path.home(), root=root, source_dir=src, expected_key=IDENTITY_KEY)

            # 4. Overlap with repo root or source directory rejected
            with self.assertRaises(DeployError):
                validate_target(root, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            with self.assertRaises(DeployError):
                validate_target(src, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            with self.assertRaises(DeployError):
                validate_target(src.parent, root=root, source_dir=src, expected_key=IDENTITY_KEY)

            # 5. Arbitrary directory without manifest rejected
            arbitrary = tmp / "arbitrary"
            arbitrary.mkdir()
            with self.assertRaises(DeployError) as ctx:
                validate_target(arbitrary, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            self.assertIn("must be an existing AgentTab extension", str(ctx.exception))

            # 6. Target with mismatched manifest.key rejected
            mismatched = tmp / "mismatched"
            create_mock_extension_bundle(mismatched, key="wrong_key")
            with self.assertRaises(DeployError) as ctx:
                validate_target(mismatched, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            self.assertIn("does not match AgentTab development extension key", str(ctx.exception))

            # 7. Target containing internal symlink rejected
            target_with_symlink = tmp / "target_with_symlink"
            create_mock_extension_bundle(target_with_symlink)
            leak_target = tmp / "leak.txt"
            leak_target.write_text("leak")
            os.symlink(leak_target, target_with_symlink / "leak_link.txt")
            with self.assertRaises(DeployError) as ctx:
                validate_target(target_with_symlink, root=root, source_dir=src, expected_key=IDENTITY_KEY)
            self.assertIn("symbolic link file", str(ctx.exception))

    def test_bundle_verification_strictness(self) -> None:
        root = repo_root()
        exp_key, _, exp_manifest_ver, exp_ver = load_identity(root)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            bundle_dir = tmp / "bundle"
            create_mock_extension_bundle(bundle_dir)

            # 1. Valid bundle passes
            files, digest = verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertTrue(len(files) >= 11)
            self.assertEqual(len(digest), 64)

            # 2. Symlink subdirectory in bundle rejected
            sub_real = tmp / "extra_dir"
            sub_real.mkdir()
            (sub_real / "sub.txt").write_text("hello")
            os.symlink(sub_real, bundle_dir / "sym_sub")
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("symbolic link", str(ctx.exception))
            (bundle_dir / "sym_sub").unlink()

            # 3. Symlink file in bundle rejected
            secret = tmp / "secret.txt"
            secret.write_text("secret")
            os.symlink(secret, bundle_dir / "sym_file.js")
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("symbolic link", str(ctx.exception))
            (bundle_dir / "sym_file.js").unlink()

            # 4. Missing required file rejected
            (bundle_dir / "wake.html").unlink()
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("missing required file: wake.html", str(ctx.exception))
            (bundle_dir / "wake.html").write_text("wake")

            # 5. Extra permissions rejected
            create_mock_extension_bundle(
                bundle_dir,
                permissions=["alarms", "debugger", "nativeMessaging", "storage", "tabGroups", "tabs", "unapprovedExtra"],
            )
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("must exactly match required set", str(ctx.exception))

            # 6. Optional or host permissions mismatch rejected
            create_mock_extension_bundle(bundle_dir, optional_permissions=[])
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("optional_permissions", str(ctx.exception))

            create_mock_extension_bundle(bundle_dir, host_permissions=["https://example.com/*"])
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("host_permissions", str(ctx.exception))

            # 7. Version mismatch rejected
            create_mock_extension_bundle(bundle_dir, version="1.0.0")
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("Bundle manifest versions must match identity", str(ctx.exception))

            # 8. Forbidden key rejected
            create_mock_extension_bundle(bundle_dir, forbidden_key="content_scripts")
            with self.assertRaises(DeployError) as ctx:
                verify_bundle(bundle_dir, exp_key, exp_manifest_ver, exp_ver)
            self.assertIn("Forbidden manifest surface detected", str(ctx.exception))

    def test_verify_installed_bytes(self) -> None:
        root = repo_root()
        exp_key, _, exp_manifest_ver, exp_ver = load_identity(root)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "src"
            create_mock_extension_bundle(src)
            tgt = tmp / "tgt"
            shutil.copytree(src, tgt)

            files, _ = verify_bundle(src, exp_key, exp_manifest_ver, exp_ver)
            # Matching bytes succeeds
            verify_installed_bytes(src, tgt, files)

            # Corrupted byte in target fails
            (tgt / "background.js").write_text("corrupted", encoding="utf-8")
            with self.assertRaises(DeployError) as ctx:
                verify_installed_bytes(src, tgt, files)
            self.assertIn("mismatch", str(ctx.exception))

            # Restore and add extra file in target fails
            (tgt / "background.js").write_text((src / "background.js").read_text(), encoding="utf-8")
            (tgt / "untracked.txt").write_text("extra", encoding="utf-8")
            with self.assertRaises(DeployError) as ctx:
                verify_installed_bytes(src, tgt, files)
            self.assertIn("extraneous file", str(ctx.exception))

    def test_readiness_checks_both_layers_strictly(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            # Script that succeeds on ipc but fails on extension
            stub_script = tmp / "stub_doctor.py"
            stub_script.write_text(
                "import sys, json\n"
                "args = sys.argv\n"
                "if '--layer' in args:\n"
                "    idx = args.index('--layer')\n"
                "    layer = args[idx + 1]\n"
                "    if layer == 'ipc':\n"
                "        print(json.dumps({'success': True, 'layer': 'ipc', 'result': {'state': 'ready'}}))\n"
                "        sys.exit(0)\n"
                "    else:\n"
                "        print(json.dumps({'success': False, 'layer': 'extension'}))\n"
                "        sys.exit(1)\n"
                "print(json.dumps({'success': False}))\n"
                "sys.exit(1)\n"
            )

            # Must fail because extension layer failed
            with self.assertRaises(DeployError) as ctx:
                poll_readiness([sys.executable, str(stub_script)], timeout_seconds=0.3)
            self.assertIn("Readiness check failed", str(ctx.exception))
            self.assertIn("extension", str(ctx.exception))

            # Script that outputs exit code 0 but empty string
            stub_empty = tmp / "stub_empty.py"
            stub_empty.write_text("import sys\nprint('')\nsys.exit(0)\n")
            with self.assertRaises(DeployError) as ctx:
                poll_readiness([sys.executable, str(stub_empty)], timeout_seconds=0.2)
            self.assertIn("Readiness check failed", str(ctx.exception))

            # Script that outputs exit 0 but success is false
            stub_false = tmp / "stub_false.py"
            stub_false.write_text("import sys, json\nprint(json.dumps({'success': False}))\nsys.exit(0)\n")
            with self.assertRaises(DeployError) as ctx:
                poll_readiness([sys.executable, str(stub_false)], timeout_seconds=0.2)
            self.assertIn("Readiness check failed", str(ctx.exception))

            # Script where state is reconciling (not ready)
            stub_reconciling = tmp / "stub_reconciling.py"
            stub_reconciling.write_text(
                "import sys, json\n"
                "args = sys.argv\n"
                "layer = args[args.index('--layer') + 1] if '--layer' in args else 'unknown'\n"
                "print(json.dumps({'success': True, 'layer': layer, 'result': {'state': 'reconciling'}}))\n"
                "sys.exit(0)\n"
            )
            with self.assertRaises(DeployError) as ctx:
                poll_readiness([sys.executable, str(stub_reconciling)], timeout_seconds=0.2)
            self.assertIn("state is not ready", str(ctx.exception))

            # Script where extension layer misses verifiable probe
            stub_no_probe = tmp / "stub_no_probe.py"
            stub_no_probe.write_text(
                "import sys, json\n"
                "args = sys.argv\n"
                "layer = args[args.index('--layer') + 1] if '--layer' in args else 'unknown'\n"
                "print(json.dumps({'success': True, 'layer': layer, 'result': {'state': 'ready'}}))\n"
                "sys.exit(0)\n"
            )
            with self.assertRaises(DeployError) as ctx:
                poll_readiness([sys.executable, str(stub_no_probe)], timeout_seconds=0.2)
            self.assertIn("missing or invalid extension probe", str(ctx.exception))

            # Script that succeeds on BOTH ipc and extension with verifiable probe
            stub_both = tmp / "stub_both.py"
            stub_both.write_text(
                "import sys, json\n"
                "args = sys.argv\n"
                "layer = args[args.index('--layer') + 1] if '--layer' in args else 'unknown'\n"
                "if layer == 'ipc':\n"
                "    print(json.dumps({'success': True, 'layer': 'ipc', 'result': {'state': 'ready'}}))\n"
                "else:\n"
                "    print(json.dumps({'success': True, 'layer': 'extension', 'result': {'state': 'ready', 'probe': 'browser_tabs', 'tabs_count': 2}}))\n"
                "sys.exit(0)\n"
            )
            result = poll_readiness([sys.executable, str(stub_both)], timeout_seconds=5.0)
            self.assertTrue(result["passed"])

    def test_rollback_on_readiness_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "src"
            create_mock_extension_bundle(src)

            version_root = tmp / "v2.0.0"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)
            (target_dir / "original_file.txt").write_text("prior content")

            receipt_file = version_root / "dev-deploy-receipt.json"
            receipt_file.write_text('{"prior": true}')

            failing_doctor = f"{sys.executable} -c \"import sys, json; print(json.dumps({{'success': False}})); sys.exit(1)\""

            args = parse_args([
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target_dir),
                "--reload-command", f"{sys.executable} -c \"print('reload')\"",
                "--doctor-command", failing_doctor,
                "--timeout", "0.2",
            ])

            with self.assertRaises(DeployError) as ctx:
                deploy(args)
            self.assertIn("On-disk state: restored from", str(ctx.exception))
            self.assertIn("Runtime state:", str(ctx.exception))

            # Target directory must be restored to prior content
            self.assertTrue((target_dir / "original_file.txt").exists())
            self.assertEqual((target_dir / "original_file.txt").read_text(), "prior content")

            # Prior receipt must be restored
            self.assertEqual(receipt_file.read_text(), '{"prior": true}')

    def test_no_false_rollback_without_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            target = tmp / "target"
            target.mkdir()
            receipt = tmp / "dev-deploy-receipt.json"

            with self.assertRaises(DeployError) as ctx:
                rollback(target, backup_dir=None, prior_receipt_content=None, receipt_path=receipt, reload_fn=None)
            self.assertIn("no prior backup existed", str(ctx.exception))

    def test_cli_smoke_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            src = root / "src_dist"
            create_mock_extension_bundle(src)

            version_dir = root / "state" / "versions" / "v2.0.0-rc.1"
            target = version_dir / "extension"
            create_mock_extension_bundle(target)
            (target / "old_bundle_marker.txt").write_text("marker_old")

            install_receipt = version_dir / "install-receipt.json"
            install_receipt.write_text('{"signedInstall": true}')

            doctor_stub = root / "doctor_stub.py"
            doctor_stub.write_text(
                "import sys, json\n"
                "args = sys.argv\n"
                "layer = args[args.index('--layer') + 1] if '--layer' in args else 'unknown'\n"
                "if layer == 'ipc':\n"
                "    print(json.dumps({'success': True, 'layer': 'ipc', 'result': {'state': 'ready'}}))\n"
                "else:\n"
                "    print(json.dumps({'success': True, 'layer': 'extension', 'result': {'state': 'ready', 'probe': 'browser_tabs', 'tabs_count': 1}}))\n"
                "sys.exit(0)\n"
            )

            reload_stub = root / "reload_stub.py"
            reload_stub.write_text("import sys\nprint('reload ok')\nsys.exit(0)\n")

            # 1. CLI Dry-Run
            cmd_dry = [
                sys.executable,
                str(repo_root() / "scripts" / "dev_deploy.py"),
                "--dry-run",
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target),
            ]
            proc_dry = subprocess.run(cmd_dry, capture_output=True, text=True)
            self.assertEqual(proc_dry.returncode, 0, f"Dry-run failed: {proc_dry.stderr}")
            self.assertIn("[dry-run] AgentTab Development Deploy Simulation Plan:", proc_dry.stdout)
            self.assertTrue((target / "old_bundle_marker.txt").exists(), "Dry-run modified target")

            # 2. CLI Live Smoke Run
            cmd_smoke = [
                sys.executable,
                str(repo_root() / "scripts" / "dev_deploy.py"),
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target),
                "--reload-command", f"{sys.executable} {reload_stub}",
                "--doctor-command", f"{sys.executable} {doctor_stub}",
                "--timeout", "5.0",
                "--json",
            ]
            proc_smoke = subprocess.run(cmd_smoke, capture_output=True, text=True)
            self.assertEqual(proc_smoke.returncode, 0, f"Smoke run failed: {proc_smoke.stderr}")

            smoke_data = json.loads(proc_smoke.stdout)
            self.assertEqual(smoke_data["status"], "deployed")
            self.assertTrue(smoke_data["readiness"]["passed"])

            # Old marker removed from target
            self.assertFalse((target / "old_bundle_marker.txt").exists())

            # Backup directory exists and contains old marker
            backup_dir = Path(smoke_data["backupDir"])
            self.assertTrue(backup_dir.is_dir())
            self.assertTrue((backup_dir / "old_bundle_marker.txt").exists())

            # Signed install receipt preserved
            self.assertEqual(install_receipt.read_text(), '{"signedInstall": true}')

            # Dev deploy receipt exists
            dev_receipt_path = Path(smoke_data["receiptPath"])
            self.assertTrue(dev_receipt_path.is_file())
            receipt_obj = json.loads(dev_receipt_path.read_text())
            self.assertEqual(receipt_obj["receiptType"], "development-deploy")
            self.assertTrue(receipt_obj["signedInstallReceiptPreserved"])

    def test_receipt_symlink_overwrite_rejected_victim_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "src"
            create_mock_extension_bundle(src)

            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            # Victim file outside target
            victim = tmp / "victim.txt"
            victim.write_text("VICTIM RECEIPT SECRET", encoding="utf-8")

            # Receipt is a hostile symlink to victim
            receipt_symlink = version_root / "dev-deploy-receipt.json"
            os.symlink(victim, receipt_symlink)

            # 1. validate_sibling_paths rejects receipt symlink
            with self.assertRaises(DeployError) as ctx:
                validate_sibling_paths(version_root)
            self.assertIn("cannot be a symbolic link", str(ctx.exception))

            # 2. write_receipt_atomic rejects receipt symlink and does not clobber victim
            with self.assertRaises(DeployError) as ctx:
                write_receipt_atomic(receipt_symlink, '{"hostile": true}')
            self.assertIn("cannot be a symbolic link", str(ctx.exception))
            self.assertEqual(victim.read_text(encoding="utf-8"), "VICTIM RECEIPT SECRET")

            # 3. deploy rejects receipt symlink pre-mutation and does not clobber victim
            args = parse_args([
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target_dir),
                "--reload-command", f"{sys.executable} -c \"print('reload')\"",
                "--doctor-command", f"{sys.executable} -c \"import sys; sys.exit(0)\"",
            ])
            with self.assertRaises(DeployError) as ctx:
                deploy(args)
            self.assertIn("cannot be a symbolic link", str(ctx.exception))
            self.assertEqual(victim.read_text(encoding="utf-8"), "VICTIM RECEIPT SECRET")

    def test_receipt_symlink_during_rollback_victim_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            backup_dir = version_root / "backup_real"
            create_mock_extension_bundle(backup_dir)

            victim = tmp / "victim_rollback.txt"
            victim.write_text("VICTIM ROLLBACK SECRET", encoding="utf-8")

            receipt_symlink = version_root / "dev-deploy-receipt.json"
            os.symlink(victim, receipt_symlink)

            # Rollback with prior receipt content replaces link safely, leaving victim untouched
            report = rollback(
                target_dir=target_dir,
                backup_dir=backup_dir,
                prior_receipt_content='{"restored": true}',
                receipt_path=receipt_symlink,
                reload_fn=None,
            )
            self.assertTrue(report["onDiskRestored"])
            self.assertEqual(victim.read_text(encoding="utf-8"), "VICTIM ROLLBACK SECRET")
            self.assertFalse(receipt_symlink.is_symlink())
            self.assertTrue(receipt_symlink.is_file())
            self.assertEqual(receipt_symlink.read_text(encoding="utf-8"), '{"restored": true}')

            # Rollback with prior_receipt_content=None unlinks symlink, leaving victim untouched
            os.unlink(receipt_symlink)
            os.symlink(victim, receipt_symlink)
            report2 = rollback(
                target_dir=target_dir,
                backup_dir=backup_dir,
                prior_receipt_content=None,
                receipt_path=receipt_symlink,
                reload_fn=None,
            )
            self.assertTrue(report2["onDiskRestored"])
            self.assertEqual(victim.read_text(encoding="utf-8"), "VICTIM ROLLBACK SECRET")
            self.assertFalse(receipt_symlink.exists())
            self.assertFalse(receipt_symlink.is_symlink())

    def test_backups_sibling_symlink_traversal_rejected_victim_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "src"
            create_mock_extension_bundle(src)

            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            # Victim directory outside target
            victim_dir = tmp / "victim_dir"
            victim_dir.mkdir()
            (victim_dir / "sensitive.txt").write_text("SENSITIVE DATA", encoding="utf-8")

            # backups is a hostile symlink to victim_dir
            backup_symlink = version_root / "backups"
            os.symlink(victim_dir, backup_symlink)

            # 1. validate_sibling_paths rejects backups symlink
            with self.assertRaises(DeployError) as ctx:
                validate_sibling_paths(version_root)
            self.assertIn("cannot be a symbolic link", str(ctx.exception))

            # 2. deploy rejects backups symlink pre-mutation and does not clobber victim dir
            args = parse_args([
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target_dir),
                "--reload-command", f"{sys.executable} -c \"print('reload')\"",
                "--doctor-command", f"{sys.executable} -c \"import sys; sys.exit(0)\"",
            ])
            with self.assertRaises(DeployError) as ctx:
                deploy(args)
            self.assertIn("cannot be a symbolic link", str(ctx.exception))

            # Victim directory is untouched
            self.assertEqual((victim_dir / "sensitive.txt").read_text(encoding="utf-8"), "SENSITIVE DATA")
            self.assertEqual(len(list(victim_dir.iterdir())), 1)

    def test_validate_sibling_paths_allows_readonly_or_unrelated_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()

            external = tmp / "external.txt"
            external.write_text("external", encoding="utf-8")

            # install-receipt.json as symlink is read-only / unrelated, must not be rejected by validate_sibling_paths
            os.symlink(external, version_root / "install-receipt.json")
            # Unrelated symlink in version_root must not be rejected
            os.symlink(external, version_root / "unrelated.txt")

            # validate_sibling_paths must succeed without error
            validate_sibling_paths(version_root)

    def test_rollback_validates_backups_parent_no_follow(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            victim_dir = tmp / "victim_backups_parent"
            victim_dir.mkdir()
            real_backup = victim_dir / "backup_real"
            create_mock_extension_bundle(real_backup)

            # backups parent is a hostile symlink to victim_dir
            backups_symlink = version_root / "backups"
            os.symlink(victim_dir, backups_symlink)

            backup_dir_through_symlink = backups_symlink / "backup_real"
            receipt_path = version_root / "dev-deploy-receipt.json"

            with self.assertRaises(DeployError) as ctx:
                rollback(
                    target_dir=target_dir,
                    backup_dir=backup_dir_through_symlink,
                    prior_receipt_content=None,
                    receipt_path=receipt_path,
                    reload_fn=None,
                )
            self.assertIn("Backups parent directory cannot be a symbolic link", str(ctx.exception))

    def test_backup_internal_symlink_during_rollback_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            backups_dir = version_root / "backups"
            backups_dir.mkdir()
            backup_dir = backups_dir / "backup_1"
            create_mock_extension_bundle(backup_dir)

            external_file = tmp / "external.txt"
            external_file.write_text("external", encoding="utf-8")

            # Symlink inside backup directory is rejected during rollback
            link_in_backup = backup_dir / "traversal_link.txt"
            os.symlink(external_file, link_in_backup)

            receipt_path = version_root / "dev-deploy-receipt.json"

            with self.assertRaises(DeployError) as ctx:
                rollback(
                    target_dir=target_dir,
                    backup_dir=backup_dir,
                    prior_receipt_content=None,
                    receipt_path=receipt_path,
                    reload_fn=None,
                )
            self.assertIn("Backup directory contains symbolic link file", str(ctx.exception))

    def test_backup_symlink_during_rollback_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            victim_dir = tmp / "victim_backup"
            create_mock_extension_bundle(victim_dir)

            backup_symlink = version_root / "sym_backup"
            os.symlink(victim_dir, backup_symlink)

            receipt_path = version_root / "dev-deploy-receipt.json"

            with self.assertRaises(DeployError) as ctx:
                rollback(
                    target_dir=target_dir,
                    backup_dir=backup_symlink,
                    prior_receipt_content=None,
                    receipt_path=receipt_path,
                    reload_fn=None,
                )
            self.assertIn("no prior backup existed", str(ctx.exception))

    def test_linux_default_reload_fails_pre_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir).resolve()
            src = tmp / "src"
            create_mock_extension_bundle(src)

            version_root = tmp / "v2.0.0-rc.1"
            version_root.mkdir()
            target_dir = version_root / "extension"
            create_mock_extension_bundle(target_dir)

            prior_marker = target_dir / "prior_marker.txt"
            prior_marker.write_text("UNTOUCHED PRE-MUTATION", encoding="utf-8")

            args = parse_args([
                "--skip-build",
                "--source-dir", str(src),
                "--target-dir", str(target_dir),
            ])

            with patch("sys.platform", "linux"):
                with self.assertRaises(DeployError) as ctx:
                    deploy(args)
                self.assertIn("unsupported on platform 'linux'", str(ctx.exception))
                self.assertIn("--debugging-url", str(ctx.exception))
                self.assertIn("--reload-command", str(ctx.exception))

            # Verify pre-mutation: target untouched, no backup, no receipt
            self.assertTrue(prior_marker.exists())
            self.assertEqual(prior_marker.read_text(encoding="utf-8"), "UNTOUCHED PRE-MUTATION")
            self.assertFalse((version_root / "backups").exists())
            self.assertFalse((version_root / "dev-deploy-receipt.json").exists())

    def test_linux_reload_with_overrides_allowed(self) -> None:
        with patch("sys.platform", "linux"):
            # 1. With --debugging-url
            args_cdp = parse_args(["--debugging-url", "http://127.0.0.1:9222"])
            check_platform_reload_support(args_cdp)

            # 2. With --reload-command
            args_cmd = parse_args(["--reload-command", "echo reload"])
            check_platform_reload_support(args_cmd)

            # 3. With custom --reload-script
            args_script = parse_args(["--reload-script", "/custom/reload.sh"])
            check_platform_reload_support(args_script)

            # 4. Without override fails
            args_default = parse_args([])
            with self.assertRaises(DeployError) as ctx:
                check_platform_reload_support(args_default)
            self.assertIn("unsupported on platform 'linux'", str(ctx.exception))

    def test_macos_platform_allows_default_reload(self) -> None:
        with patch("sys.platform", "darwin"):
            args_default = parse_args([])
            # Succeeds without error
            check_platform_reload_support(args_default)

if __name__ == "__main__":
    unittest.main()
