import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AgentIdentityIcon,
  BradleyGlyph,
} from '../app/components/agents/AgentIdentityVisual';

function main(): void {
  const glyph = renderToStaticMarkup(<BradleyGlyph title="Bradley" className="h-4 w-4" />);
  assert.match(glyph, /viewBox="0 0 64 64"/u);
  assert.match(glyph, /role="img"/u);
  assert.match(glyph, /aria-label="Bradley"/u);
  assert.match(glyph, /<title>Bradley<\/title>/u);
  assert.match(glyph, /class="[^"]*\bh-4 w-4\b/u);
  assert.equal((glyph.match(/<circle /gu) || []).length, 2);

  const decorativeGlyph = renderToStaticMarkup(<BradleyGlyph className="h-3.5 w-3.5" />);
  assert.match(decorativeGlyph, /aria-hidden="true"/u);
  assert.doesNotMatch(decorativeGlyph, /role="img"/u);

  const mainAgentIcon = renderToStaticMarkup(
    <AgentIdentityIcon agentId="canvas-agent" iconId="bot" className="h-5 w-5" />,
  );
  assert.match(mainAgentIcon, /viewBox="0 0 64 64"/u);
  assert.doesNotMatch(mainAgentIcon, /lucide-bot/u);

  const specialistIcon = renderToStaticMarkup(
    <AgentIdentityIcon agentId="research-agent" iconId="search" className="h-5 w-5" />,
  );
  assert.match(specialistIcon, /lucide-search/u);
  assert.doesNotMatch(specialistIcon, /viewBox="0 0 64 64"/u);

  console.log('bradley-glyph-ui-test: ok');
}

main();
