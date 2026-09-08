/* Maintainer recipe for the pinned 0.5.3 patch. Run only against pristine package files. */
/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS maintenance script. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = 'node_modules/@eigenpal/docx-js-editor';
const sourceRoot = process.argv[2] ?? packageRoot;
const backupRoot = '.docx-editor-patch-original';
fs.mkdirSync(backupRoot, { recursive: true });
const changed = [];
function rewrite(file, transform) {
  const filename = `${packageRoot}/${file}`;
  const original = fs.readFileSync(`${sourceRoot}/${file}`, 'utf8');
  if (original.includes('canvasWorkspaceBound')) throw new Error(`${file} already patched`);
  const result = transform(original);
  const backup = path.join(backupRoot, file);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, original);
  fs.writeFileSync(filename, result);
  changed.push({ filename, backup });
}
function exact(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Expected one patch target: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

for (const [file, hook, convert] of [
  ['dist/chunk-5SHALB3Z.mjs', '', 'kr'],
  ['dist/chunk-KO42TOIK.js', '_p.', 'kr'],
]) rewrite(file, (source) => {
  source = exact(source, 'documentBuffer:t,document:n,onSave:r,', 'documentBuffer:t,document:n,onSave:r,canvasWorkspaceBound=false,onSaveRequest,');
  const start = source.indexOf('var zp=');
  const end = source.indexOf('function Zw(', start);
  let component = source.slice(start, end);
  const firstHook = component.indexOf(`let{t:qe}=`);
  if (firstHook < 0) throw new Error('Editor initialization not found');
  const insertion = `let canvasDocumentRef=${hook}useRef(n||null),canvasOnChangeRef=${hook}useRef(s),canvasReadonlyRef=${hook}useRef(C||re==="viewing"),canvasChangedRef=${hook}useRef(false);canvasOnChangeRef.current=s;canvasReadonlyRef.current=C||re==="viewing";let canvasNotify=${hook}useCallback((value,comments=tt.current)=>{if(canvasReadonlyRef.current||!value)return;canvasChangedRef.current=true;let complete={...value,package:{...value.package,document:{...value.package.document,content:structuredClone(value.package.document.content),comments:structuredClone(comments)}}};bb(complete.package.document.content,complete.package.document.comments);yb(complete.package.document.content,complete.package.document.comments);canvasOnChangeRef.current?.(complete);},[]);`;
  component = component.slice(0, firstHook) + insertion + component.slice(firstHook);
  component = exact(component,
    `Ve=${hook}useCallback(l=>{let i=typeof l=="function"?l(tt.current):l;i!==tt.current&&(mo||(tt.current=i,po(i)),ei.current?.(i));},[mo])`,
    `Ve=${hook}useCallback((l,notify=true)=>{if(notify&&canvasReadonlyRef.current)return;let i=typeof l=="function"?l(tt.current):l;if(i!==tt.current){mo||(tt.current=i,po(i));ei.current?.(i);notify&&canvasNotify(canvasDocumentRef.current,i);}},[mo,canvasNotify])`);
  component = exact(component, 'return i?g:l});},[Nt,Ve])', 'return i?g:l},canvasChangedRef.current);},[Nt,Ve])');
  component = exact(component, 'Ve(i),ft(true),$n.current=true', 'Ve(i,false),ft(true),$n.current=true');
  component = exact(component, 'Ot.current=false,Ve([]),', 'Ot.current=false,Ve([],false),');
  component = exact(component, 'Se(),Y.reset(l),', 'Se(),canvasDocumentRef.current=l,canvasChangedRef.current=false,tt.current=l.package?.document?.comments??[],Y.reset(l),');
  component = exact(component, 'groupingInterval:500,enableKeyboardShortcuts:true', 'groupingInterval:500,enableKeyboardShortcuts:!canvasWorkspaceBound,onUndo:l=>{canvasDocumentRef.current=l;canvasNotify(l);},onRedo:l=>{canvasDocumentRef.current=l;canvasNotify(l);}');
  component = exact(component,
    `st=${hook}useCallback(l=>(Y.push(l),l),[Y]),Je=${hook}useCallback(l=>{st(l),s?.(l);`,
    `st=${hook}useCallback(l=>{if(canvasReadonlyRef.current)return l;canvasDocumentRef.current=l;Y.push(l);canvasNotify(l);return l;},[Y,canvasNotify]),Je=${hook}useCallback(l=>{st(l);`);
  component = exact(component, 'onDocumentChange:Je,', 'onDocumentChange:l=>{let current=canvasDocumentRef.current??l;Je({...current,package:{...current.package,document:{...current.package.document,content:l.package.document.content}}});},');
  component = exact(component, `fm=${hook}useCallback(async()=>{let l=await hi();`, `fm=${hook}useCallback(async()=>{if(onSaveRequest){await onSaveRequest();return;}if(canvasWorkspaceBound)return;let l=await hi();`);
  component = exact(component, '},[hi,tn]),gm=', '},[hi,tn,onSaveRequest,canvasWorkspaceBound]),gm=');
  component = exact(component, `gm=${hook}useCallback(()=>{lr.current?.click();},[])`, `gm=${hook}useCallback(()=>{if(!canvasWorkspaceBound)lr.current?.click();},[canvasWorkspaceBound])`);
  component = exact(component, `hm=${hook}useCallback(async l=>{let i=l.target.files?.[0];`, `hm=${hook}useCallback(async l=>{if(canvasWorkspaceBound){l.target.value="";return;}let i=l.target.files?.[0];`);
  const errorCallback = hook ? 'c' : 'c$3';
  component = exact(component, `},[Ke,Ee,${errorCallback}])`, `},[Ke,Ee,${errorCallback},canvasWorkspaceBound])`);
  component = exact(component, 'onOpen:gm,onSave:fm,', 'onOpen:canvasWorkspaceBound?void 0:gm,onSave:fm,');
  // Every header transaction commits its model while keeping the inline editor open.
  component = exact(component, `Ts=${hook}useCallback(l=>{`, `Ts=${hook}useCallback((l,close=true)=>{if(canvasReadonlyRef.current)return;`);
  component = exact(component, 'st(ne);}mt(null);},[Re,Y,st])', 'st(ne);}if(close)mt(null);},[Re,Y,st])');
  component = exact(component, 'onSave:Ts,onClose:()=>mt(null),', 'onSave:Ts,onChange:l=>Ts(l,false),onClose:()=>mt(null),');
  component = exact(component, 'Re&&(()=>{let l=co?', 'Re&&!Fe&&(()=>{let l=co?');
  component = exact(component, `Sm=${hook}useCallback((l,i)=>{`, `Sm=${hook}useCallback((l,i)=>{if(canvasReadonlyRef.current)return;`);
  for (const name of ['gi', 'Sm', 'Ts', 'wm', 'Gn', 'lm']) {
    const match = new RegExp(`${name.replace('$', '\\$')}=${hook.replace('.', '\\.')}useCallback\\(`).exec(component);
    if (!match) throw new Error(`Missing document mutation ${name}`);
    const begin = match.index;
    const next = component.indexOf(']),', begin) + 3;
    if (next < begin) throw new Error(`Missing mutation boundary ${name}`);
    component = component.slice(0, begin) + component.slice(begin, next).replaceAll('Y.state', 'canvasDocumentRef.current') + component.slice(next);
  }
  source = source.slice(0, start) + component + source.slice(end);
  // The header editor previously held changes until blur. Notify synchronously from PM dispatch.
  const close = hook ? 'c' : 'c$1';
  source = exact(source, `onSave:a,onClose:${close},onSelectionChange:p,onRemove:d},u)`, `onSave:a,onChange:canvasHeaderChange,onClose:${close},onSelectionChange:p,onRemove:d},u)`);
  source = exact(source, `T.current=p;let x=${hook}useMemo`, `T.current=p;let canvasHeaderChangeRef=${hook}useRef(canvasHeaderChange);canvasHeaderChangeRef.current=canvasHeaderChange;let x=${hook}useMemo`);
  source = exact(source, 'X.docChanged&&b(true),X.selectionSet||X.docChanged', `X.docChanged&&(b(true),canvasHeaderChangeRef.current?.(${convert}(re.doc))),X.selectionSet||X.docChanged`);
  // The shipped readonly effect was a no-op, leaving the initial editable closure active.
  source = exact(source, `q.current=b,C.current=r;let oe=`, `q.current=b,C.current=r;let canvasReadonlyRef=${hook}useRef(c);canvasReadonlyRef.current=c;let oe=`);
  source = exact(source, 'dispatchTransaction(he){if(P.current)return;', 'dispatchTransaction(he){if(P.current||(canvasReadonlyRef.current&&he.docChanged))return;');
  source = exact(source, `${hook}useEffect(()=>{x.current;},[c])`, `${hook}useEffect(()=>{x.current?.setProps({editable:()=>!c});},[c])`);
  return source;
});

for (const file of ['dist/react-C6A1efbL.d.ts', 'dist/react-CHpczuSG.d.mts']) rewrite(file, (source) => exact(source,
  'interface DocxEditorProps {',
  'interface DocxEditorProps {\n    /** Canvas: suppress local Open and route Save to the workspace protocol. */\n    canvasWorkspaceBound?: boolean;\n    onSaveRequest?: () => void | Promise<void>;'));

let patch = '';
for (const { filename, backup } of changed) {
  const result = spawnSync('git', ['diff', '--no-index', '--', backup, filename], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 1) throw new Error(`Could not generate patch: ${result.stderr}`);
  patch += result.stdout.replaceAll(`a/${backup}`, `a/${filename}`);
}
fs.writeFileSync('patches/@eigenpal+docx-js-editor+0.5.3.patch', patch);
fs.rmSync(backupRoot, { recursive: true });
console.log('Generated pinned DOCX mutation-event patch.');
