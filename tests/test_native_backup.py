"""Synthetic backup artifacts only; no production export is accessed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verify_backup", ROOT / "scripts/verify-native-backup.py")
verify_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_module)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        body = b"synthetic restoration fixture"
        self.sha = hashlib.sha256(body).hexdigest()
        (self.root / "object.bin").write_bytes(body)
        db = sqlite3.connect(":memory:")
        db.executescript("""CREATE TABLE attachments(id TEXT PRIMARY KEY, r2_key TEXT, size_bytes INTEGER, sha256 TEXT);""")
        for name in ("0018_married_praxagora.sql", "0022_attachment_v2_uploads.sql", "0023_attachment_scan_jobs.sql"):
            path = ROOT / "drizzle" / name
            db.executescript(path.read_text())
        db.execute("INSERT INTO attachments VALUES ('mail-fixture', 'email/fixture', ?, ?)", (len(body), self.sha))
        db.execute("""INSERT INTO attachment_v2_objects(id,owner_kind,owner_id,file_name,content_type,byte_size,sha256,storage_key,object_version,created_by,created_at)
          VALUES ('11111111-1111-4111-8111-111111111111','account','org-fixture','fixture','text/plain',?,?,'attachments-v2/objects/fixture','fixture-version','test','2026-10-22T00:00:00Z')""", (len(body), self.sha))
        db.execute("""INSERT INTO attachment_v2_uploads(id,creator,session_id,idempotency_key,manifest_json,manifest_sha256,byte_size,created_at,expires_at)
          VALUES ('upload-fixture','test','session-fixture','key-fixture','{}',?,?,'2026-10-22T00:00:00Z','2026-10-23T00:00:00Z')""", (self.sha, len(body)))
        db.execute("""INSERT INTO attachment_v2_chunks(upload_id,part_index,byte_size,sha256,storage_key,object_version,etag,created_at)
          VALUES ('upload-fixture',0,?,?,'attachments-v2/staging/fixture/0','fixture-version','fixture-etag','2026-10-22T00:00:00Z')""", (len(body), self.sha))
        self.sql = self.root / "snapshot.sql"; self.sql.write_text("\n".join(db.iterdump()))
        self.manifest = {"version": 1, "databaseSha256": hashlib.sha256(self.sql.read_bytes()).hexdigest(),
                         "tableCounts": {row[0]: db.execute(f'SELECT COUNT(*) FROM "{row[0]}"').fetchone()[0]
                                         for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")},
                         "objects": [{"key": key, "file": "object.bin", "sha256": self.sha, "byteSize": len(body)}
                                     for key in ("email/fixture", "attachments-v2/objects/fixture", "attachments-v2/staging/fixture/0")]}
        db.close(); self.manifest_path = self.root / "manifest.json"; self.save_manifest()

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def check(self):
        return verify_module.verify(self.sql, self.manifest_path, self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_roundtrip_is_local_and_never_claims_production(self):
        report = self.check()
        self.assertEqual(report["status"], "passed")
        self.assertFalse(report["productionVerified"])
        self.assertFalse(report["cloudflareRestoreTested"])
        self.assertEqual(report["referencedObjects"], 3)
        self.assertNotIn("fixture", json.dumps(report))

    def test_corrupt_bytes_rejected(self):
        (self.root / "object.bin").write_bytes(b"corrupted")
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_missing_object_rejected(self):
        (self.root / "object.bin").unlink()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_missing_inventory_reference_rejected(self):
        for omitted in range(len(self.manifest["objects"])):
            original = self.manifest["objects"]
            self.manifest["objects"] = original[:omitted] + original[omitted + 1:]
            self.save_manifest()
            with self.assertRaises(verify_module.InvalidBackup): self.check()
            self.manifest["objects"] = original

    def test_v2_schema_and_dedup_index_are_required(self):
        self.sql.write_text(self.sql.read_text() + "\nDROP INDEX attachment_v2_active_dedup;")
        self.manifest["databaseSha256"] = hashlib.sha256(self.sql.read_bytes()).hexdigest(); self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_tombstoned_native_bytes_remain_required_for_recovery(self):
        self.sql.write_text(self.sql.read_text() + "\nUPDATE attachment_v2_objects SET deleted_at='2026-10-22T00:00:00Z';")
        self.manifest["databaseSha256"] = hashlib.sha256(self.sql.read_bytes()).hexdigest()
        self.manifest["objects"] = [entry for entry in self.manifest["objects"]
                                    if entry["key"] != "attachments-v2/objects/fixture"]
        self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_truncated_or_changed_export_rejected(self):
        self.sql.write_text(self.sql.read_text()[:100])
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_outside_paths_and_symlinks_rejected(self):
        for path in ("../outside", "/etc/passwd"):
            self.manifest["objects"][0]["file"] = path; self.save_manifest()
            with self.assertRaises(verify_module.InvalidBackup): self.check()
        (self.root / "linked").symlink_to(self.root / "object.bin")
        self.manifest["objects"][0]["file"] = "linked"; self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_duplicate_keys_rejected(self):
        self.manifest["objects"].append(self.manifest["objects"][0]); self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_sql_cannot_attach_or_overwrite_any_external_database(self):
        target = self.root / "must-not-exist.db"
        self.sql.write_text(self.sql.read_text() + f"\nATTACH DATABASE '{target}' AS external;")
        self.manifest["databaseSha256"] = hashlib.sha256(self.sql.read_bytes()).hexdigest(); self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()
        self.assertFalse(target.exists())

    def test_sqlite_without_extension_loading_api_is_supported(self):
        raw_connection = sqlite3.connect(":memory:")

        class ConnectionWithoutExtensionLoading:
            def __getattr__(self, name):
                if name == "enable_load_extension":
                    raise AttributeError(name)
                return getattr(raw_connection, name)

        connection = ConnectionWithoutExtensionLoading()
        with mock.patch.object(verify_module.sqlite3, "connect", return_value=connection):
            self.assertEqual(self.check()["status"], "passed")

    def test_schema_and_table_counts_required(self):
        self.manifest["tableCounts"]["attachment_v2_objects"] += 1; self.save_manifest()
        with self.assertRaises(verify_module.InvalidBackup): self.check()

    def test_report_does_not_claim_reusable_scanner_approval(self):
        self.assertFalse(self.check()["scanReceiptsReusableAfterR2Restore"])


if __name__ == "__main__":
    unittest.main()
