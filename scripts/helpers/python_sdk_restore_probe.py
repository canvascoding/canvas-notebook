import asyncio,hashlib,importlib.metadata,json,logging,sys,zipfile
from pathlib import Path
from canvas_notebook import CanvasMcpTransport,CanvasNotebook
logging.disable(logging.CRITICAL)
async def main():
 c=json.load(sys.stdin)
 d=importlib.metadata.distribution('canvas-notebook-python')
 assert sys.prefix!=sys.base_prefix
 direct=json.loads(d.read_text('direct_url.json'));assert direct['url']==Path(c['wheel']).as_uri()
 wheel=Path(c['wheel']);assert hashlib.sha256(wheel.read_bytes()).hexdigest()==c['wheelSha256']
 with zipfile.ZipFile(wheel) as z:
  for entry in z.namelist():
   if entry.startswith('canvas_notebook/') and not entry.endswith('/'):
    assert Path(d.locate_file(entry)).read_bytes()==z.read(entry)
 async with CanvasMcpTransport(c['origin']+'/mcp',api_key=c['key'],read_timeout=20) as transport:
  n=CanvasNotebook(transport)
  b=await n.read_all(c['workspaceId'],c['documentId'],format='markdown')
  assert c['oldText'] in b.body
  if c.get('operationId'):
   historical=(await n.edit_status(c['workspaceId'],c['operationId'])).require_success()
   assert historical['state']=='confirmed' and historical['persistence']['status']=='confirmed'
  edit=(await n.edit_document(c['workspaceId'],c['documentId'],expected_version=b.document['version'],idempotency_key=c['idempotencyKey'],patch={'kind':'native_text_replace','edits':[{'oldText':c['oldText'],'newText':c['newText'],'expectedOccurrences':1}]})).require_success()
  assert edit['state']=='confirmed' and edit['persistence']['status']=='confirmed' and edit['effect']['outcome']=='applied'
  status=(await n.edit_status(c['workspaceId'],edit['operationId'])).require_success();assert status['state']=='confirmed'
  after=await n.read_all(c['workspaceId'],c['documentId'],format='markdown');assert c['newText'] in after.body and c['oldText'] not in after.body
  created=None
  if c.get('createPath'):
   created=(await n.create_markdown(c['workspaceId'],c['createPath'],'# SDK after restore\n\nCreated via installed SDK.\n',idempotency_key=c['idempotencyKey']+'-create')).require_success()
   doc=created['document'];r=await n.read_all(c['workspaceId'],doc['documentId'],format='markdown');assert 'Created via installed SDK.' in r.body
  print(json.dumps({'passed':True,'operationId':edit['operationId'],'version':after.document['version'],'historicalStatusVerified':bool(c.get('operationId')),'created':created,'python':sys.version.split()[0],'installedWheelVerified':True}))
asyncio.run(main())
