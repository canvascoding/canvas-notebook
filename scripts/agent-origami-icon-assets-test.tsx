import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentIcon } from '../app/components/agents/AgentAvatar';
import { SubagentIcon } from '../app/components/agents/SubagentIcon';
import { AGENT_ICON_IDS } from '../app/lib/agents/icons';

const root = process.cwd();

function main(): void {
  assert.equal(AGENT_ICON_IDS.length, 13);

  for (const iconId of AGENT_ICON_IDS) {
    const publicPath = path.join(root, 'public', 'images', 'agents', 'origami', `${iconId}.svg`);
    const masterPath = path.join(
      root,
      'docs',
      'architecture',
      'canvas-notebook',
      'assets',
      'agent-origami-icons',
      'glyphs',
      `${iconId}.svg`,
    );
    const runtimeSvg = readFileSync(publicPath, 'utf8');
    const masterSvg = readFileSync(masterPath, 'utf8');

    assert.equal(runtimeSvg, masterSvg, `${iconId} runtime asset must match its editable master`);
    assert.match(runtimeSvg, /viewBox="0 0 64 64"/u);
    assert.match(runtimeSvg, /<title id="title">/u);
    assert.match(runtimeSvg, /<desc id="desc">/u);
    assert.doesNotMatch(runtimeSvg, /<(?:script|filter|linearGradient|radialGradient)\b/u);
    assert.doesNotMatch(runtimeSvg, /(?:href|xlink:href)="(?!#)/u);

    const markup = renderToStaticMarkup(<AgentIcon iconId={iconId} className="h-5 w-5" />);
    assert.match(markup, new RegExp(`data-agent-icon-id="${iconId}"`, 'u'));
    assert.match(markup, new RegExp(`src="/images/agents/origami/${iconId}\\.svg"`, 'u'));
    assert.match(markup, /aria-hidden="true"/u);
    assert.match(markup, /class="[^"]*h-5 w-5/u);
  }

  const fallback = renderToStaticMarkup(<AgentIcon iconId="unknown-agent-icon" />);
  assert.match(fallback, /data-agent-icon-id="bot"/u);
  assert.match(fallback, /src="\/images\/agents\/origami\/bot\.svg"/u);

  const subagentRuntimePath = path.join(root, 'public', 'images', 'agents', 'origami', 'subagents.svg');
  const subagentMasterPath = path.join(
    root,
    'docs',
    'architecture',
    'canvas-notebook',
    'assets',
    'agent-origami-icons',
    'glyphs',
    'subagents.svg',
  );
  const subagentRuntimeSvg = readFileSync(subagentRuntimePath, 'utf8');
  assert.equal(subagentRuntimeSvg, readFileSync(subagentMasterPath, 'utf8'));
  assert.match(subagentRuntimeSvg, /viewBox="0 0 64 64"/u);
  assert.match(subagentRuntimeSvg, /<title id="title">/u);
  assert.match(subagentRuntimeSvg, /<desc id="desc">/u);
  assert.doesNotMatch(subagentRuntimeSvg, /<(?:script|filter|linearGradient|radialGradient)\b/u);
  assert.doesNotMatch(subagentRuntimeSvg, /(?:href|xlink:href)="(?!#)/u);

  const subagentMarkup = renderToStaticMarkup(<SubagentIcon className="h-5 w-5" />);
  assert.match(subagentMarkup, /data-agent-feature-icon="subagents"/u);
  assert.match(subagentMarkup, /src="\/images\/agents\/origami\/subagents\.svg"/u);
  assert.match(subagentMarkup, /aria-hidden="true"/u);

  const board = readFileSync(
    path.join(
      root,
      'docs',
      'architecture',
      'canvas-notebook',
      'assets',
      'agent-origami-icons',
      'previews',
      'family-board.svg',
    ),
    'utf8',
  );
  assert.equal((board.match(/data:image\/svg\+xml;base64,/gu) || []).length, AGENT_ICON_IDS.length * 4);
  assert.doesNotMatch(board, /href="(?!data:|#)/u);

  console.log('agent-origami-icon-assets-test: ok');
}

main();
