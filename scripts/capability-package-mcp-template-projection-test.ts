import assert from 'node:assert/strict';
import { projectCapabilityPackageMcpTemplateConfig } from '../app/lib/capabilities/packages/mcp-template-projection';

const credential = 'PRIVATE_TEMPLATE_CREDENTIAL';
const root = '/private/template/source';
const result = projectCapabilityPackageMcpTemplateConfig({mcpServers: {
  selected: {command: 'npx', args: ['-y', '@example/mcp', '--token', credential, `--api-key=${credential}`, root,
    '--header', `Authorization: Bearer ${credential}`, '${CANVAS_TOKEN}'],
  env: {TOKEN: credential, REFERENCED: '${CANVAS_TOKEN}'}, headers: {Authorization: credential, Accept: 'application/json'},
  cwd: root, oauth: {clientSecret: credential, tokenUrl: `https://oauth.example.test/token?api_key=${credential}`,
    issuer: 'https://oauth.example.test', scopes: ['read']}, unknownSecret: credential},
  other: {url: `https://other.example.test/${credential}`},
}}, 'selected');
const body = JSON.stringify(result);
assert(!body.includes(credential));assert(!body.includes(root));assert(!body.includes('other.example.test'));
assert.equal(result.config.command, 'npx');
assert.deepEqual(result.config.args, ['-y', '@example/mcp', '--token', '', '', '', '--header', '', '${CANVAS_TOKEN}']);
assert.deepEqual(result.config.env, {TOKEN: '', REFERENCED: '${CANVAS_TOKEN}'});
assert.deepEqual(result.config.headers, {Authorization: '', Accept: 'application/json'});
assert.deepEqual(result.config.oauth, {issuer: 'https://oauth.example.test', scopes: ['read']});
assert.equal(result.config.cwd, undefined);assert.equal(result.config.unknownSecret, undefined);
assert(result.redactedFields.includes('oauth.tokenUrl'));
assert.throws(() => projectCapabilityPackageMcpTemplateConfig({mcpServers: {other: {url: 'https://mcp.example.test'}}}, 'selected'),
  /declared MCP template was not found/u, 'A server-map mismatch never treats the whole file as the selected server');
assert.throws(() => projectCapabilityPackageMcpTemplateConfig({mcpServers: {}}, '__proto__'),
  /declared MCP template was not found/u, 'Inherited keys are never declared MCP templates');
const unsafeEndpoint = projectCapabilityPackageMcpTemplateConfig({url: `https://user:${credential}@mcp.example.test`, command: 'C:\\private\\server.exe'}, 'selected');
assert.deepEqual(unsafeEndpoint.config, {});assert.deepEqual(unsafeEndpoint.redactedFields, ['command', 'url']);
assert(!JSON.stringify(unsafeEndpoint).includes(credential));
console.log('Capability package MCP template exact server selection, credential/path redaction and portable defaults PASS.');
