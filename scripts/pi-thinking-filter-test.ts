import assert from 'node:assert/strict';
import {
  createThinkingFilterState,
  filterThinkingChunk,
  flushThinkingFilter,
  stripThinkingMarkup,
} from '../app/lib/pi/thinking-filter';

function streamedText(chunks: string[]): string {
  let state = createThinkingFilterState();
  let text = '';
  for (const chunk of chunks) {
    const result = filterThinkingChunk(chunk, state);
    text += result.text;
    state = result.state;
  }
  return text + flushThinkingFilter(state).text;
}

const cases = [
  ['Hello', 'Hello'],
  ['Before </think> After', 'Before  After'],
  ['<think>private</think>Answer', 'Answer'],
  ['Before <thinking>private</thinking> After', 'Before  After'],
  ['<reasoning>private</reasoning>Answer', 'Answer'],
  ['<THINK>private</THINK>Answer</ThInK>', 'Answer'],
  ['<think>private', ''],
  ['2 < 3 and <thing> stays', '2 < 3 and <thing> stays'],
  ['Answer </thi', 'Answer </thi'],
] as const;

for (const [input, expected] of cases) {
  assert.equal(stripThinkingMarkup(input), expected.trim(), `completed: ${input}`);
  assert.equal(streamedText([input]), expected, `one chunk: ${input}`);
  for (let split = 1; split < input.length; split += 1) {
    assert.equal(streamedText([input.slice(0, split), input.slice(split)]), expected, `split at ${split}: ${input}`);
  }
  assert.equal(streamedText([...input]), expected, `single-character chunks: ${input}`);
}

console.log('pi-thinking-filter-test: ok');
