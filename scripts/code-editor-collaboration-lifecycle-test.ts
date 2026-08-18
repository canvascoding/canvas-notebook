import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, 'app', 'components', 'editor', 'CodeEditor.tsx'),
  'utf8',
);

assert.match(
  source,
  /const onChangeRef = useRef\(onChange\);/u,
  'CodeMirror must retain the latest parent change handler without replacing its callback',
);
assert.match(
  source,
  /useEffect\(\(\) => \{\s*onChangeRef\.current = onChange;\s*\}, \[onChange\]\);/u,
  'the retained change handler must follow parent callback updates',
);
assert.match(
  source,
  /const handleChange = useCallback\(\(nextValue: string\) => \{\s*onChangeRef\.current\(nextValue\);\s*\}, \[\]\);/u,
  'the callback passed to CodeMirror must stay stable across draft updates',
);
assert.match(
  source,
  /<CodeMirror[\s\S]*?onChange=\{handleChange\}/u,
  'CodeMirror must receive the stable handler so yCollab is not reconfigured on each edit',
);

console.log('code-editor-collaboration-lifecycle-test: ok');
