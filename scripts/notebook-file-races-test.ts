import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
const file = (path: string, content: string) => ({ path, content, stats: { size: content.length, modified: 1, permissions: '100644' } });
function setup() {
 useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
 useFileStore.getState().resetWorkspaceView('ws-a');
 useEditorStore.getState().clear();
 useFileStore.setState({currentFile: file('a.txt', 'original A'), currentFileWorkspaceId: 'ws-a'});
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return {resolve, promise}; }
async function main() {
 setup();
 const slow = deferred<Response>();
 globalThis.fetch = (async () => slow.promise) as typeof fetch;
 const b = useFileStore.getState().revealAndLoadFile('b.txt', {revealInTree: false});
 const a = await useFileStore.getState().revealAndLoadFile('a.txt', {revealInTree: false});
 slow.resolve(Response.json({success:true, data:file('b.txt','late B')}));
 const bResult = await b;
 assert.equal(a.status, 'opened'); assert.equal(bResult.status, 'superseded');
 assert.equal(useFileStore.getState().currentFile?.path, 'a.txt');
 console.log('latest file selection: ok');
 setup();
 const old404 = deferred<Response>();
 globalThis.fetch = (async () => old404.promise) as typeof fetch;
 const refresh = useFileStore.getState().refreshCurrentFileContent('a.txt');
 useWorkspaceStore.setState({activeWorkspaceId: 'ws-b'});
 useFileStore.getState().resetWorkspaceView('ws-b');
 useFileStore.setState({currentFile:file('a.txt','workspace B'),currentFileWorkspaceId:'ws-b'});
 old404.resolve(new Response('', {status:404}));
 await refresh;
 assert.equal(useFileStore.getState().currentFile?.content, 'workspace B');
 console.log('workspace refresh isolation: ok');
 setup();
 const stale = deferred<Response>();
 let calls=0;
 globalThis.fetch = (async () => ++calls===1 ? stale.promise : Response.json({success:true,data:file('a.txt','NEW')})) as typeof fetch;
 const first = useFileStore.getState().refreshCurrentFileContent('a.txt');
 await useFileStore.getState().refreshCurrentFileContent('a.txt');
 stale.resolve(Response.json({success:true,data:file('a.txt','OLD')}));
 await first;
 assert.equal(useFileStore.getState().currentFile?.content, 'NEW');
 console.log('refresh ordering: ok');
 setup();
 useEditorStore.getState().setActiveFile('a.txt', 'original A');
 const afterTyping = deferred<Response>();
 globalThis.fetch = (async () => afterTyping.promise) as typeof fetch;
 const refreshingCleanFile = useFileStore.getState().refreshCurrentFileContent('a.txt');
 useEditorStore.getState().updateDraft('new local draft');
 afterTyping.resolve(Response.json({success:true,data:file('a.txt','external change')}));
 assert.equal(await refreshingCleanFile, null);
 assert.equal(useFileStore.getState().currentFile?.content, 'original A');
 assert.equal(useEditorStore.getState().draft, 'new local draft');
 console.log('refresh preserves edits made during the request: ok');

}
main().catch(error => { console.error(error); process.exitCode=1; });
