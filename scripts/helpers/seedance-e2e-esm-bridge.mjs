import Module from 'node:module';
import {pathToFileURL} from 'node:url';
const modules = new Map();
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth', '@earendil-works/pi-agent-core']) {
 const [, scope, pkg, ...subpath] = name.match(/^(@[^/]+)\/([^/]+)(?:\/(.*))?$/) || [];
 const base = process.cwd() + '/node_modules/' + scope + '/' + pkg;
 const suffix = subpath[0] || 'index';
 modules.set(name, await import(pathToFileURL(base + '/dist/' + suffix + '.js').href));
}
const original = Module._load;
Module._load = function(name, parent, main) { return modules.has(name) ? modules.get(name) : original(name, parent, main); };
