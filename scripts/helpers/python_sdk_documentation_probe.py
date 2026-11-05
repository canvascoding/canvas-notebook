"""Run the published read examples against a caller-owned compiled fixture.

Credentials arrive only through bounded stdin. The controller owns issuance,
revocation and fixture preservation; this probe performs reads only.
"""
from __future__ import annotations

import ast
import asyncio
import hashlib
import importlib.metadata
import json
import logging
from pathlib import Path
import re
import sys
import zipfile

import httpx2
import canvas_notebook
from canvas_notebook import CanvasMcpTransport, CanvasNotebook

logging.disable(logging.CRITICAL)
phase = None
requests = []
phases = []
original_send = httpx2.AsyncClient.send


async def main():
    global phase
    config = json.loads(sys.stdin.buffer.readline(65537))
    assert config['origin'] == 'http://127.0.0.1:3100'
    key = config.pop('key')
    config.pop('cookie', None)
    assert key.startswith('cnk_')
    dist = importlib.metadata.distribution('canvas-notebook-python')
    assert dist.version == '0.1.1' and sys.prefix != sys.base_prefix
    assert 'site-packages' in Path(canvas_notebook.__file__).resolve().parts
    wheel = Path(config['wheel'])
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == config['wheelSha256']
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if name.startswith('canvas_notebook/') and not name.endswith('/'):
                assert Path(dist.locate_file(name)).read_bytes() == archive.read(name)
    root = Path(__file__).resolve().parents[2]
    sdk_file = root / 'docs/product/en/developers/python-sdk.mdx'
    rest_file = root / 'docs/product/en/developers/document-api.mdx'
    sdk_source, rest_source = sdk_file.read_text(), rest_file.read_text()
    example = re.search(r'```python\n(.*?)\n```', sdk_source, re.S).group(1)
    module = ast.parse(example)
    read = [node for node in module.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'read_first_hit']
    assert len(read) == 1 and not read[0].decorator_list
    scopes = [ast.literal_eval(keyword.value) for node in ast.walk(module)
              if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'CanvasOAuth'
              for keyword in node.keywords if keyword.arg == 'scopes']
    assert scopes == [('openid', 'offline_access', 'workspace:list', 'knowledge:search', 'knowledge:read')]
    namespace = {}
    exec(compile(ast.Module(body=read, type_ignores=[]), str(sdk_file), 'exec'), namespace)
    read_first_hit = namespace['read_first_hit']
    template = json.loads(re.search(r'```json\n(.*?)\n```', rest_source, re.S).group(1))
    assert template == {'apiVersion': 1, 'workspaceId': 'your-workspace-id', 'query': 'Target', 'scopePath': '.', 'limit': 8}
    workspace, doc = config['workspaceId'], config['document']

    async def send(client, request, *args, **kwargs):
        assert request.headers.get('x-canvas-api-key') == key
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        request.headers['x-canvas-qa-phase'] = phase
        response = await original_send(client, request, *args, **kwargs)
        requests.append({'sampleId': phase, 'route': request.url.path, 'status': response.status_code})
        return response

    def begin(name):
        global phase
        phase = config['nonce'] + '-documentation-' + name
        phases.append({'sampleId': phase, 'example': name})

    httpx2.AsyncClient.send = send
    try:
        async with httpx2.AsyncClient(base_url=config['origin'], headers={'X-Canvas-API-Key': key}, timeout=30) as client:
            begin('rest-search')
            response = await client.post('/api/documents/search', json={**template, 'workspaceId': workspace, 'query': doc['path']})
            assert response.status_code == 200
            hits = response.json()['hits']
            assert hits and hits[0]['document']['documentId'] == doc['documentId']
            ref = hits[0]['document']
            begin('rest-read')
            response = await client.post('/api/documents/read', json={'apiVersion': 1, 'workspaceId': workspace,
                'documentId': ref['documentId'], 'expectedVersion': ref['version'], 'format': 'native', 'maxBytes': 262144})
            assert response.status_code == 200
            page = response.json()
            assert page['complete'] and page['document']['version'] == ref['version']
            native = json.loads(page['fragment'])
        begin('sdk-connect')
        async with CanvasMcpTransport(config['origin'] + '/mcp', api_key=key, read_timeout=30) as transport:
            notebook = CanvasNotebook(transport)
            begin('sdk-read-first-hit')
            complete = await read_first_hit(notebook, workspace, doc['path'])
            assert complete is not None and complete.document['documentId'] == ref['documentId']
            assert complete.document['version'] == ref['version']
            assert json.loads(complete.body) == native
            begin('sdk-no-hit-continuations')
            missing = '__documentation_no_hit_' + config['nonce'] + '__'
            assert await read_first_hit(notebook, workspace, missing) is None
            # The small fixture contains more than the eight-candidate scan window.
            assert len([r for r in requests if r['sampleId'] == phase and r['route'] == '/mcp']) >= 2
        assert transport._client is None and transport._stack is None
    finally:
        httpx2.AsyncClient.send = original_send
    assert len(phases) == 5 and all(any(r['sampleId'] == p['sampleId'] for r in requests) for p in phases)
    assert all(r['status'] == 200 for r in requests)
    print(json.dumps({'passed': True, 'installedVersion': dist.version, 'sourceCount': config['sourceCount'],
        'wheelSha256': config['wheelSha256'], 'phases': phases, 'http': requests,
        'documentationHashes': {str(f.relative_to(root)): hashlib.sha256(f.read_bytes()).hexdigest() for f in [sdk_file, rest_file]},
        'scopeOfEvidence': 'Published REST search JSON and unchanged Python read_first_hit function, using an issued API key; OAuth issuance is a separate acceptance.'}), flush=True)


if __name__ == '__main__':
    try:
        asyncio.run(asyncio.wait_for(main(), 120))
    except Exception as error:
        print(json.dumps({'passed': False, 'phase': phase, 'errorType': type(error).__name__}), flush=True)
        sys.exit(1)
