"""Fresh installed SDK artifacts; runtime integrity and dependency profiles."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

INTEGRITY = r'''
import hashlib, importlib.metadata, importlib.util, json, pathlib, sys
root=pathlib.Path(sys.argv[1]); profile=sys.argv[2]
source=root/'packages/canvas-notebook-python/src/canvas_notebook'
files={p.name:p.read_bytes() for p in source.iterdir() if p.is_file() and (p.suffix=='.py' or p.name=='py.typed')}
assert files
project=importlib.metadata.distribution('canvas-notebook-python')
installed={str(p).removeprefix('canvas_notebook/') for p in project.files or ()
           if str(p).startswith('canvas_notebook/') and (str(p).endswith('.py') or str(p).endswith('/py.typed'))}
assert installed==set(files)
for name,body in files.items():
    assert pathlib.Path(project.locate_file('canvas_notebook/'+name)).read_bytes()==body
import canvas_notebook
assert pathlib.Path(canvas_notebook.__file__).resolve()==pathlib.Path(project.locate_file('canvas_notebook/__init__.py')).resolve()
from canvas_notebook import CanvasNotebook, OriginalImportedDocument, OriginalImportSource
from canvas_notebook import OriginalDocumentImportConfirmedResult, OriginalDocumentImportNotFoundResult, OriginalDocumentImportResult
assert all((OriginalImportedDocument,OriginalImportSource,OriginalDocumentImportConfirmedResult,OriginalDocumentImportNotFoundResult,OriginalDocumentImportResult))
assert callable(CanvasNotebook.import_existing_markdown) and callable(CanvasNotebook.original_import_status)
for dependency in ('mcp','mcp_types','httpx2','keyring'):
    available=importlib.util.find_spec(dependency) is not None
    if profile=='core': assert not available
    elif dependency!='keyring' or profile=='keyring': assert available
print(json.dumps({'runtimeFiles':len(files),'sourceHashes':{n:hashlib.sha256(b).hexdigest() for n,b in files.items()},'python':sys.version.split()[0],'version':project.version}))
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist-dir', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--github-env', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    assert sys.version_info >= (3, 10)
    artifacts = {}
    for kind, pattern in (('wheel', '*.whl'), ('sdist', '*.tar.gz')):
        matches = list(args.dist_dir.resolve().glob(pattern)); assert len(matches) == 1
        artifact = matches[0]; assert artifact.is_file() and not artifact.is_symlink()
        artifacts[kind] = (artifact, hashlib.sha256(artifact.read_bytes()).hexdigest())
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    records = []
    selected_python = None
    report = output / 'report.json'

    def run(command: list[str], log: Path, isolated: bool = False) -> None:
        environment = None
        if isolated:
            environment = {name: os.environ[name] for name in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT') if name in os.environ}
        with log.open('w', encoding='utf8') as stream:
            result = subprocess.run(command, cwd=root, env=environment, stdin=subprocess.DEVNULL,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=600, check=False)
        if result.returncode:
            raise RuntimeError(f'{log.name}: exit {result.returncode}')

    for kind, (artifact, digest) in artifacts.items():
        for profile, extras in (('core', ''), ('mcp', '[mcp]'), ('keyring', '[mcp,keyring]')):
            name = f'{kind}-{profile}'; directory = output / name
            run([sys.executable, '-m', 'venv', str(directory)], output / f'{name}-venv.log')
            python = directory / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            requirement = f'canvas-notebook-python{extras} @ {artifact.as_uri()}'
            run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', requirement], output / f'{name}-install.log')
            run([str(python), '-m', 'pip', 'check'], output / f'{name}-dependencies.log')
            integrity_log = output / f'{name}-integrity.log'
            run([str(python), '-I', '-c', INTEGRITY, str(root), profile], integrity_log, True)
            integrity = json.loads(integrity_log.read_text(encoding='utf8').splitlines()[-1])
            pattern = 'test_core_import.py' if profile == 'core' else 'test_*.py'
            test_log = output / f'{name}-tests.log'
            run([str(python), '-I', '-m', 'unittest', 'discover', '-s', str(root / 'packages/canvas-notebook-python/tests'), '-p', pattern], test_log, True)
            tests = test_log.read_text(encoding='utf8'); count = re.search(r'Ran (\d+) tests? in ', tests)
            assert count and int(count.group(1)) > 0 and not re.search(r'\bskipped=[1-9]', tests)
            assert hashlib.sha256(artifact.read_bytes()).hexdigest() == digest
            record = {'python': integrity['python'], 'artifact': kind, 'profile': profile,
                      'sha256': digest, 'tests': int(count.group(1)), 'skipped': 0, 'integrity': integrity, 'exitCode': 0}
            records.append(record)
            report.write_text(json.dumps({'complete': False, 'records': records}, indent=2) + '\n', encoding='utf8')
            print(json.dumps({key: value for key, value in record.items() if key != 'integrity'}), flush=True)
            if kind == 'wheel' and profile == 'keyring': selected_python = python
    assert selected_python
    if args.github_env:
        values = {'CANVAS_SDK_TEST_PYTHON': str(selected_python), 'CANVAS_SDK_TEST_WHEEL': str(artifacts['wheel'][0])}
        assert all('\n' not in value and '\r' not in value for value in values.values())
        with args.github_env.open('a', encoding='utf8') as stream:
            for key, value in values.items(): stream.write(f'{key}={value}\n')
    report.write_text(json.dumps({'complete': True, 'records': records, 'nativePython': str(selected_python),
                                 'wheel': str(artifacts['wheel'][0]), 'osKeyringAcceptance': False}, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
