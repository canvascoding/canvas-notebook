import assert from 'node:assert/strict';
import { htmlPreviewOrigins, htmlPreviewUrl, isHtmlPreviewHost } from '../app/lib/html-preview-origin';

const production={BASE_URL:'https://app.example.com'};
assert.deepEqual(htmlPreviewOrigins(production),{appOrigin:'https://app.example.com',previewOrigin:'https://preview.app.example.com'});
assert.equal(htmlPreviewUrl('/__preview/fixture/index.html',production),'https://preview.app.example.com/__preview/fixture/index.html');
assert.equal(isHtmlPreviewHost('preview.app.example.com',production),true);
assert.equal(isHtmlPreviewHost('preview.app.example.com:443',production),true);
for(const host of ['app.example.com','preview.app.example.com:80','preview.app.example.com.evil.test','preview.app.example.com@evil.test']) assert.equal(isHtmlPreviewHost(host,production),false);
assert.equal(htmlPreviewOrigins({BASE_URL:'http://127.0.0.1:3000'}).previewOrigin,'http://preview.localhost:3000');
assert.equal(htmlPreviewOrigins({...production,CANVAS_HTML_PREVIEW_ORIGIN:'https://documents.example.net'}).previewOrigin,'https://documents.example.net');
for(const preview of ['https://app.example.com:444','http://preview.app.example.com','https://preview.app.example.com/path','https://user:password@preview.app.example.com','https://app.example.com.']) {
  assert.throws(()=>htmlPreviewOrigins({...production,CANVAS_HTML_PREVIEW_ORIGIN:preview}));
}
assert.throws(()=>htmlPreviewOrigins({BASE_URL:'https://192.0.2.1'}),/CANVAS_HTML_PREVIEW_ORIGIN/);
console.log('HTML preview origin tests passed');
