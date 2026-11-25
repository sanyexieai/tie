#!/usr/bin/env python3
"""Read a legacy Tie SQLite snapshot and export or migrate into a new data root."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', '--source', type=Path, required=True)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument('--output', type=Path, help='New, empty Node backend data directory')
    destination.add_argument('--export-json', type=Path, help='Export for a separate Node container import')
    parser.add_argument('--legacy-data-dir', type=Path, help='Old TIE_BACKEND_DATA_DIR; defaults to database parent')
    parser.add_argument('--node', default='node')
    parser.add_argument('--helper', type=Path, default=Path(__file__).with_suffix('.mjs'))
    args = parser.parse_args()
    database = args.database.resolve(strict=True)
    payload = read_snapshot(database)
    payload['legacyDataDir'] = str((args.legacy_data_dir or database.parent).resolve(strict=True))
    encoded = json.dumps(payload, ensure_ascii=False)
    if args.export_json:
        # The export includes password hashes; never send it to stdout or make it world-readable.
        descriptor = os.open(args.export_json, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(encoded)
        print(json.dumps(payload['counts']))
        return
    result = subprocess.run(
        [args.node, str(args.helper.resolve()), '--output', str(args.output.resolve())],
        input=encoded, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Node import failed')
    print(result.stdout.strip())


def read_snapshot(database):
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only = ON')
        connection.execute('BEGIN')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        required = {'users', 'workspaces', 'pages', 'page_revisions'}
        if not required.issubset(tables):
            raise ValueError('Missing required legacy backend tables')
        payload = {
            'schemaVersion': 1,
            'users': [dict(row) for row in connection.execute('SELECT id,email,name,password_hash,created_at FROM users')],
            'admins': [dict(row) for row in connection.execute('SELECT id,username,email,password_hash,created_at,is_active FROM admin_users')]
                if 'admin_users' in tables else [],
            'workspaces': [dict(row) for row in connection.execute('SELECT id,name,owner_id,created_at FROM workspaces')],
            'pages': [dict(row) for row in connection.execute('SELECT id,workspace_id,title,icon,parent_id,sort_key,markdown,tags,created_at,updated_at,deleted_at FROM pages')],
            'revisions': [dict(row) for row in connection.execute('SELECT id,workspace_id,page_id,saved_at,title,page_json FROM page_revisions')],
        }
        provider_ids = set()
        bound_workspaces = set()
        for table in ['storage_sources', 'user_storage_providers']:
            if table not in tables:
                continue
            for row in connection.execute(f"SELECT id,workspace_id FROM {table} WHERE kind IN ('s3','minio')"):
                provider_ids.add(row['id'])
                if row['workspace_id']:
                    bound_workspaces.add(row['workspace_id'])
        columns = {row[1] for row in connection.execute('PRAGMA table_info(workspaces)')}
        if 'storage_provider_id' in columns:
            bound_workspaces.update(row[0] for row in connection.execute(
                "SELECT id FROM workspaces WHERE storage_provider_id IS NOT NULL AND storage_provider_id <> ''"
            ))
        payload['counts'] = {
            'legacyUsers': len(payload['users']), 'legacyAdmins': len(payload['admins']),
            'workspaces': len(payload['workspaces']), 'pages': len(payload['pages']),
            'revisions': len(payload['revisions']), 'skippedS3Providers': len(provider_ids),
            'skippedProviderBindings': len(bound_workspaces),
        }
        return payload


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(f'Migration failed: {error}', file=sys.stderr)
        raise SystemExit(1)
