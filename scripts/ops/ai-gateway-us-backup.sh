#!/usr/bin/env bash
# Installed as /usr/local/sbin/ai-gateway-us-backup on meow_us.
set -Eeuo pipefail
umask 077

source_dir=/opt/ai-gateway
controller_dir=/opt/aistudio-channel-controller
local_dir=/srv/backups/ai-gateway-us
remote_dir=gdrive:meow_us-aistudio-auth-backup
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$local_dir/ai-gateway-us-$stamp.tar.gz"

test -d "$source_dir/aistudio/auth"
mkdir -p "$local_dir"
exec 9>/run/ai-gateway-us-backup.lock
flock -n 9 || exit 0
snapshot=$(mktemp -d /var/tmp/ai-gateway-us-backup.XXXXXX)
cleanup() {
  rm -rf -- "$snapshot"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$snapshot/aistudio/auth" "$snapshot/aistudio/data" "$snapshot/antigravity/data" "$snapshot/secrets" "$snapshot/controller/data" "$snapshot/backup"

cp "$source_dir/aistudio/data/scheduler-state.json" "$snapshot/aistudio/data/"
if [[ -f "$source_dir/aistudio/data/proxy-pool.json" ]]; then
  cp "$source_dir/aistudio/data/proxy-pool.json" "$snapshot/aistudio/data/"
fi
cp "$source_dir/.env" "$source_dir/compose.yaml" "$snapshot/"
cp "$source_dir/secrets/downstream-key-response.json" "$snapshot/secrets/"
if [[ -d "$controller_dir/data" ]]; then
  rsync -a "$controller_dir/data/" "$snapshot/controller/data/"
  cp "$controller_dir/.env" "$controller_dir/config.yaml" "$controller_dir/compose.yaml" "$snapshot/controller/"
fi
cp "$0" "$snapshot/backup/ai-gateway-us-backup"
cp /etc/systemd/system/ai-gateway-us-backup.{service,timer} "$snapshot/backup/"

python3 - "$source_dir" "$snapshot" <<'PY'
import json
import pathlib
import sqlite3
import subprocess
import sys
import time

root, snapshot = map(pathlib.Path, sys.argv[1:])

def backup(source_path, target_path):
    deadline = time.monotonic() + 60
    def progress(*_):
        if time.monotonic() > deadline:
            raise TimeoutError('SQLite backup exceeded 60 seconds')
    # Online SQLite backup includes committed WAL contents; never copy a live DB.
    source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=10)
    target = sqlite3.connect(target_path)
    try:
        source.backup(target, pages=256, progress=progress)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('SQLite integrity check failed')
        if target.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('SQLite foreign key check failed')
    finally:
        target.close()
        source.close()

backup(root / 'antigravity/data/keys.sqlite', snapshot / 'antigravity/data/keys.sqlite')
backup(root / 'aistudio/data/usage-stats.sqlite', snapshot / 'aistudio/data/usage-stats.sqlite')
def copy_account_files():
    for directory in ('aistudio/auth', 'aistudio/data/account-login-artifacts'):
        source = root / directory
        if source.is_dir():
            target = snapshot / directory
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            subprocess.run(['rsync', '-a', '--delete', '--exclude=*.tmp',
                            str(source) + '/', str(target) + '/'], check=True, timeout=30)

def account_value(file):
    with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=10) as database:
        row = database.execute('SELECT value FROM account_state WHERE id=1').fetchone()
        if not row:
            raise RuntimeError('Account state missing')
        return row[0]

accounts = root / 'aistudio/data/accounts.sqlite'
if accounts.exists():
    target = snapshot / 'aistudio/data/accounts.sqlite'
    # Optimistic consistency: retry if login/session writes overlap the file copy.
    # No container pause, queue pause, process signal or application write lock.
    for attempt in range(5):
        backup(accounts, target)
        value = account_value(target)
        state = json.loads(value)
        if not isinstance(state, dict):
            raise RuntimeError('Account state invalid')
        consistent = not state.get('commits')
        try:
            copy_account_files()
            consistent = consistent and account_value(accounts) == value
            for account in state.get('accounts', []):
                index = account.get('authIndex')
                if index is None:
                    continue
                file = snapshot / f'aistudio/auth/auth-{index}.json'
                data = json.loads(file.read_text())
                consistent = consistent and data.get('_accountSessionVersion', 0) == account['sessionVersion']
            for artifact in state.get('artifacts', []):
                if not (snapshot / 'aistudio/data/account-login-artifacts' / (artifact['id'] + '.png')).is_file():
                    consistent = False
        except (FileNotFoundError, json.JSONDecodeError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            consistent = False
        if consistent:
            print('Account database and session files verified without pausing service')
            break
        if attempt == 4:
            raise RuntimeError('Account state changed during backup or session files mismatch; no archive uploaded')
        time.sleep(1)
else:
    copy_account_files()

# Recovery state and event history must travel together. Retry an optimistic
# snapshot instead of archiving a journal that changed during the DB backup.
recovery_names = ('scheduler-state.json', 'build-projects.json', 'build-projects.json.events.json')
for attempt in range(5):
    before = {name: (root / 'aistudio/data' / name).read_bytes()
              for name in recovery_names if (root / 'aistudio/data' / name).exists()}
    backup(root / 'aistudio/data/usage-stats.sqlite', snapshot / 'aistudio/data/usage-stats.sqlite')
    after = {name: (root / 'aistudio/data' / name).read_bytes()
             for name in recovery_names if (root / 'aistudio/data' / name).exists()}
    if before == after:
        for name, content in before.items():
            target = snapshot / 'aistudio/data' / name
            target.write_bytes(content)
            target.chmod(0o600)
        for source in (root / 'aistudio/data').glob('build-projects.json.pre-v2-*'):
            target = snapshot / 'aistudio/data' / source.name
            target.write_bytes(source.read_bytes())
            target.chmod(0o600)
        print('Build recovery journal and event database snapshot verified')
        break
    if attempt == 4:
        raise RuntimeError('Build recovery state changed during backup; no archive uploaded')
    time.sleep(1)
PY

tar -C "$snapshot" -czf "$archive" .
chmod 0600 "$archive"
rclone copyto "$archive" "$remote_dir/$(basename "$archive")" --log-level ERROR
printf '%s\n' "Backup uploaded: $(basename "$archive")"
