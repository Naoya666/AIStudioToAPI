"""Exercise the installed backup algorithm against a concurrently changing WAL DB."""
import ast
import json
import pathlib
import sqlite3
import tempfile
import time


def verify(script):
    text = script.read_text()
    start = text.index("<<'PY'\n") + len("<<'PY'\n")
    end = text.index('\nPY\n', start)
    embedded = text[start:end]
    functions = [node for node in ast.parse(embedded).body
                 if isinstance(node, ast.FunctionDef) and node.name == 'backup']
    assert len(functions) == 1
    start = embedded.index('# Pin the SQLite read transaction')
    recovery = embedded[start:]
    with tempfile.TemporaryDirectory(prefix='backup-recovery-test-') as directory:
        root = pathlib.Path(directory) / 'live'
        snapshot = pathlib.Path(directory) / 'snapshot'
        data = root / 'aistudio/data'
        target = snapshot / 'aistudio/data'
        data.mkdir(parents=True)
        target.mkdir(parents=True)
        journal = data / 'build-projects.json'
        scheduler = data / 'scheduler-state.json'
        journal.write_text(json.dumps({'version': 1}))
        scheduler.write_text(json.dumps({'version': 1}))
        (data / 'build-projects.json.pre-v2-fixture').write_text('{}')
        (data / 'build-projects.json.pre-v3-fixture').write_text('{}')
        (data / 'build-projects.json.archive.json').write_text('{"retained-proof": true}')
        db = data / 'usage-stats.sqlite'
        with sqlite3.connect(db) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE events(id INTEGER)')
            writer.execute('INSERT INTO events VALUES(1)')
        scope = dict(pathlib=pathlib, sqlite3=sqlite3, time=time,
                     root=root, snapshot=snapshot)
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(script), 'exec'), scope)
        backup = scope['backup']

        def concurrent_backup(source_path, target_path, source=None):
            assert source is not None and source.in_transaction
            # Change both live stores after snapshot acquisition but before copying.
            with sqlite3.connect(db) as writer:
                writer.execute('INSERT INTO events VALUES(2)')
            journal.write_text(json.dumps({'version': 2}))
            scheduler.write_text(json.dumps({'version': 2}))
            backup(source_path, target_path, source=source)

        scope['backup'] = concurrent_backup
        exec(compile(recovery, str(script), 'exec'), scope)
        with sqlite3.connect(target / 'usage-stats.sqlite') as saved:
            assert saved.execute('SELECT id FROM events ORDER BY id').fetchall() == [(1,)]
            assert saved.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        with sqlite3.connect(db) as writer:
            assert writer.execute('SELECT COUNT(*) FROM events').fetchone()[0] == 2
        assert json.loads((target / journal.name).read_text()) == {'version': 1}
        assert json.loads((target / scheduler.name).read_text()) == {'version': 1}
        assert json.loads(journal.read_text()) == {'version': 2}
        assert (target / 'build-projects.json.pre-v2-fixture').read_text() == '{}'
        assert (target / 'build-projects.json.pre-v3-fixture').read_text() == '{}'
        assert json.loads((target / 'build-projects.json.archive.json').read_text()) == {'retained-proof': True}
        assert (target / journal.name).stat().st_mode & 0o777 == 0o600
    print('Concurrent writes preserved; archived DB and recovery files retain the pinned snapshot')


if __name__ == '__main__':
    import sys
    script = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else (
        pathlib.Path(__file__).resolve().parents[1] / 'scripts/ops/ai-gateway-us-backup.sh')
    verify(script)
