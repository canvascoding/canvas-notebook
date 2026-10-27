/** Optional read-only baseline profiler. Use NODE_OPTIONS=--import=./scripts/helpers/document-query-callsite-profiler.mjs.
 * Reuses the existing baseline output path with .callers.json. Only code files,
 * symbols and counts survive; no SQL, parameters, document paths or actor IDs.
 * The original driver receives exactly its original arguments and replies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, SourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';

const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
if (process.argv[1]?.endsWith('/dispatch.mjs') && output && path.isAbsolute(output)) {
  const root = process.cwd();
  const requireFromRoot = createRequire(path.join(root,'package.json'));
  const { Client } = requireFromRoot('pg');
  const original = Client.prototype.query;
  const records = new Map();
  const runtimeKey = Symbol.for('canvas.document-operation-metrics.v1');
  const catalogue = /\b(?:pg_stat_activity|pg_namespace|pg_class|pg_database|pg_attribute|pg_constraint|pg_trigger|to_regclass|to_regnamespace|current_schema|pg_current_xact_id(?:_if_assigned)?)\b/iu;
  let stackFailures = 0;
  const ts = requireFromRoot('typescript');
  const bundle = path.resolve(process.argv[1]);
  const bundleMap = new SourceMap(JSON.parse(fs.readFileSync(bundle+'.map','utf8')));
  const sourceFunctions = new Map();
  function sourceFunction(file, line, fallback) {
    let functions = sourceFunctions.get(file);
    if (!functions) {
      const absolute = path.resolve(root,'app/lib',file);
      if (!absolute.startsWith(path.join(root,'app/lib')+path.sep)) return fallback;
      const ast = ts.createSourceFile(absolute,fs.readFileSync(absolute,'utf8'),ts.ScriptTarget.Latest,true);
      functions = [];
      const add = (node,name) => functions.push({name,start:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line,
        end:ast.getLineAndCharacterOfPosition(node.getEnd()).line});
      for (const node of ast.statements) {
        if (ts.isFunctionDeclaration(node) && node.name) add(node,node.name.text);
        if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
          if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) add(declaration.initializer,declaration.name.getText(ast));
        }
      }
      sourceFunctions.set(file,functions);
    }
    return functions.find(fn=>fn.start<=line && fn.end>=line)?.name ?? fallback;
  }
  function owningFrames() {
    const previous = Error.stackTraceLimit;
    let probe;
    try { Error.stackTraceLimit = 22; probe = {}; Error.captureStackTrace(probe, profiledQuery); }
    finally { Error.stackTraceLimit = previous; }
    const frames = [];
    for (const line of String(probe.stack).split('\n').slice(1)) {
      let name,location,lineNumber,columnNumber;
      const named = /^\s*at\s+(.*?)\s+\((.*):(\d+):(\d+)\)$/u.exec(line);
      const unnamed = named ? undefined : /^\s*at\s+(.*):(\d+):(\d+)$/u.exec(line);
      if (named) { [,name,location,lineNumber,columnNumber]=named; }
      else if (unnamed) { [,location,lineNumber,columnNumber]=unnamed; name='<anonymous>'; }
      else continue;
      let original=location,originalLine=Number(lineNumber)-1;
      const actual = location.startsWith('file:') ? fileURLToPath(location) : location;
      if (actual === bundle) {
        const entry=bundleMap.findEntry(Number(lineNumber)-1,Number(columnNumber)-1);
        original=entry.originalSource ?? ''; originalLine=entry.originalLine; name=entry.name || name;
      }
      const marker=original.lastIndexOf('/app/lib/');
      const file=marker>=0 ? original.slice(marker+9) : original.startsWith('app/lib/') ? original.slice(8) : undefined;
      if (!file || file.startsWith('db/') || file.startsWith('observability/')) continue;
      name=sourceFunction(file,originalLine,name.replace(/^async\s+/u,'').replace(/^Object\./u,''));
      const item={file,name,line:originalLine+1};
      if (!frames.some(f=>f.file===item.file && f.name===item.name)) frames.push(item);
    }
    return frames.slice(0,10);
  }
  function profiledQuery(...args) {
    const runtime = globalThis[runtimeKey];
    if (runtime?.measuredClients?.has(this) && runtime.activities?.size) {
      for (const state of runtime.activities) {
        if (state.closed) continue;
        let record = records.get(state);
        if (!record) { record = { calls: 0, groups: new Map(), owners: new Map(), chains: new Map() }; records.set(state, record); }
        record.calls++;
        const input = args[0], text = typeof input === 'string' ? input
        : input && typeof input === 'object' && !isProxy(input) ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
        const group = typeof text !== 'string' || text.length > 32768 ? 'other'
          : /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LOCK)\b/iu.test(text) ? 'transaction'
          : catalogue.test(text) ? 'catalogue' : 'other';
        record.groups.set(group, (record.groups.get(group) ?? 0) + 1);
        let frames = [];
        try { frames = owningFrames(); } catch { stackFailures++; }
        const nearest = frames[0], key = nearest ? `${nearest.file}:${nearest.name}` : 'unattributed';
        let owner = record.owners.get(key);
        if (!owner) { owner = { calls: 0, catalogue: 0, lines: new Set() }; record.owners.set(key, owner); }
        owner.calls++; if (group === 'catalogue') owner.catalogue++; if (nearest) owner.lines.add(nearest.line);
        const chain = frames.map(frame => `${frame.file}:${frame.name}`).join(' <- ') || 'unattributed';
        record.chains.set(chain, (record.chains.get(chain) ?? 0) + 1);
      }
    }
    return Reflect.apply(original, this, args);
  }
  Client.prototype.query = profiledQuery;
  process.once('exit', () => {
    if (!records.size) return;
    const windows = [...records].map(([state, record], index) => ({ index,
      actor: state.actor, operation: state.operation, closed: state.closed, measuredStatements: state.statements,
      observedCalls: record.calls, exactCountMatch: state.statements === record.calls,
      groups: Object.fromEntries(record.groups),
      owners: [...record.owners].map(([owner, value]) => ({ owner, calls: value.calls, catalogue: value.catalogue, lines: [...value.lines].sort((a,b) => a-b) })).sort((a,b) => b.calls-a.calls),
      chains: [...record.chains].map(([chain,calls]) => ({ chain,calls })).sort((a,b) => b.calls-a.calls),
    }));
    fs.writeFileSync(output+'.callers.json', JSON.stringify({ version: 1,
      scope: 'read-only diagnostic of actual instrumented runtime SQL in existing measurement windows; only code symbols/counts retained',
      stackFailures, windows }, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  });
}
