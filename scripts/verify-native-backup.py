#!/usr/bin/env python3
"""Restore a supplied SQL export only into disposable SQLite and verify copied R2 bytes.
No network, Cloudflare command, export creation, production write, cleanup or deletion.
A pass proves local artifact consistency, not live D1 restore rights or provenance.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3
import sys
import time


class InvalidBackup(Exception):
    pass


def digest_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_file(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or "\\" in relative or "\x00" in relative:
        raise InvalidBackup("invalid_object_path")
    parts = PurePosixPath(relative)
    if parts.is_absolute() or any(p in (".", "..") for p in parts.parts) or not parts.parts:
        raise InvalidBackup("invalid_object_path")
    candidate = root.joinpath(*parts.parts)
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise InvalidBackup("object_outside_backup")
    current = root
    for part in parts.parts:
        current /= part
        if current.is_symlink():
            raise InvalidBackup("symlink_not_allowed")
    if not candidate.is_file():
        raise InvalidBackup("object_missing")
    return candidate


def verify(sql_file: Path, manifest_file: Path, objects_root: Path) -> dict[str, object]:
    if sql_file.stat().st_size > 256 * 1024 * 1024 or manifest_file.stat().st_size > 16 * 1024 * 1024:
        raise InvalidBackup("backup_artifact_too_large")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    sql_digest = digest_file(sql_file)
    if manifest.get("version") != 1 or manifest.get("databaseSha256") != sql_digest:
        raise InvalidBackup("database_digest_mismatch")
    expected = manifest.get("tableCounts")
    entries = manifest.get("objects")
    if not isinstance(expected, dict) or not isinstance(entries, list):
        raise InvalidBackup("invalid_inventory")
    connection = sqlite3.connect(":memory:")
    disable_extension_loading = getattr(connection, "enable_load_extension", None)
    if disable_extension_loading is not None:
        disable_extension_loading(False)
    deadline = time.monotonic() + 30
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
    connection.execute("PRAGMA trusted_schema=OFF")

    def authorize(action, arg1, arg2, database, trigger):
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_CREATE_VTABLE):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() in ("load_extension", "readfile", "writefile"):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() not in ("foreign_keys", "defer_foreign_keys"):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    try:
        connection.set_authorizer(authorize)
        connection.executescript(sql_file.read_text(encoding="utf-8"))
        connection.set_authorizer(None)
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise InvalidBackup("sqlite_integrity_failed")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise InvalidBackup("foreign_keys_failed")
        # Structural checks do not claim that the live migration journal was read.
        for statement in (
            "SELECT nonce, expires_at FROM internal_api_nonces WHERE 0",
            "SELECT address, city FROM organizations WHERE 0",
            "SELECT phone FROM contacts WHERE 0",
            "SELECT id, owner_kind, owner_id, sha256, byte_size, storage_key, deleted_at FROM mobile_attachments WHERE 0",
            "SELECT id, r2_key, size_bytes, sha256 FROM attachments WHERE 0",
        ):
            connection.execute(statement)
        indexes = connection.execute("PRAGMA index_list(mobile_attachments)").fetchall()
        if not any(row[1] == "mobile_attachments_active_dedup_unique" and row[2] == 1 and row[4] == 1 for row in indexes):
            raise InvalidBackup("native_dedup_index_missing")
        names = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        if names != set(expected) or not all(type(n) is int and n >= 0 for n in expected.values()):
            raise InvalidBackup("table_inventory_mismatch")
        for name, count in expected.items():
            # Names originate in the restored schema, but still quote identifiers.
            escaped = name.replace('"', '""')
            if connection.execute(f'SELECT COUNT(*) FROM "{escaped}"').fetchone()[0] != count:
                raise InvalidBackup("table_count_mismatch")
        inventory = {}
        total = 0
        for entry in entries:
            key, expected_sha, size = entry.get("key"), entry.get("sha256"), entry.get("byteSize")
            if not isinstance(key, str) or not key or key in inventory:
                raise InvalidBackup("duplicate_or_invalid_object_key")
            if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha) or type(size) is not int or size < 0:
                raise InvalidBackup("invalid_object_metadata")
            path = safe_file(objects_root, entry.get("file"))
            if path.stat().st_size != size or digest_file(path) != expected_sha:
                raise InvalidBackup("object_integrity_failed")
            inventory[key] = (expected_sha, size)
            total += size
        referenced = set()
        for query in (
            "SELECT storage_key, sha256, byte_size FROM mobile_attachments WHERE deleted_at IS NULL",
            "SELECT r2_key, sha256, size_bytes FROM attachments",
        ):
            for key, expected_sha, size in connection.execute(query):
                if not expected_sha:
                    raise InvalidBackup("unverifiable_legacy_object_checksum")
                if inventory.get(key) != (expected_sha, size):
                    raise InvalidBackup("referenced_object_missing_or_mismatched")
                referenced.add(key)
        return {"status": "passed", "scope": "local_sql_restore_and_copied_r2_bytes",
                "productionVerified": False, "cloudflareRestoreTested": False,
                "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "databaseSha256": sql_digest, "manifestSha256": digest_file(manifest_file),
                "tablesChecked": len(names), "objectsChecked": len(inventory),
                "referencedObjects": len(referenced), "unreferencedInventoryObjects": len(set(inventory) - referenced),
                "bytesChecked": total, "scanReceiptsReusableAfterR2Restore": False}
    except (sqlite3.Error, UnicodeError, KeyError, TypeError, ValueError) as exc:
        raise InvalidBackup("invalid_or_incomplete_backup") from exc
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sql", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--objects", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(args.sql, args.manifest, args.objects)
    except Exception as exc:
        # Never echo SQL, file names, object keys, customer data or OS exception paths.
        result = {"status": "failed", "productionVerified": False,
                  "error": str(exc) if isinstance(exc, InvalidBackup) else "backup_verification_failed"}
        print(json.dumps(result, sort_keys=True)); return 1
    print(json.dumps(result, sort_keys=True)); return 0


if __name__ == "__main__":
    sys.exit(main())
