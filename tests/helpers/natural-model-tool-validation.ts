type TranscriptBlock = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type TranscriptMessage = { role: string; content?: string | readonly TranscriptBlock[]; toolName?: string; toolCallId?: string;
  isError?: boolean; details?: Record<string, unknown> };
const GATEWAY = 'canvas_extensions', OPERATION = 'search_canvas_extensions';
const hasError = (message: TranscriptMessage) => Boolean(message.isError || message.details?.error || message.details?.integrationError);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Test-only classification of one observed SDK pre-execution enum mistake.
 * This grants no source authority and does not validate discovery hits or reads.
 */
export function assertNaturalModelToolResults(messages: readonly TranscriptMessage[]): number {
  const fail = (): never => { throw new Error('The natural-model transcript contains a disallowed or unrecovered tool error.'); };
  const errors = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'toolResult' && hasError(message));
  if (!errors.length) return 0;
  if (errors.length !== 1) return fail();
  const calls = messages.flatMap((message, index) => message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'toolCall').map(call => ({ call, index })) : []);
  const { message: error, index: errorIndex } = errors[0]!;
  const originals = calls.filter(({ call }) => call.id === error.toolCallId);
  if (originals.length !== 1) return fail();
  const original = originals[0]!, args = original.call.arguments;
  if (error.toolName !== GATEWAY || original.call.name !== GATEWAY || original.index >= errorIndex || error.isError !== true
    || !object(error.details) || Object.keys(error.details).length !== 0 || !object(args) || !exactKeys(args, ['action', 'query'])
    || args.action !== OPERATION || typeof args.query !== 'string' || !args.query.length) return fail();
  // Exact installed-SDK enum diagnostic, including the actual received args.
  // A provider/ACL/read/operation error with a similar prefix cannot qualify.
  const expected = `Validation failed for tool "${GATEWAY}":\n  - action: must be equal to constant\n  - action: must be equal to constant\n  - action: must be equal to constant\n  - action: must match a schema in anyOf\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
  if (!Array.isArray(error.content) || error.content.length !== 1 || error.content[0]?.type !== 'text' || error.content[0].text !== expected) return fail();
  const successfulResult = (id: string | undefined, after: number) => {
    if (!id || calls.filter(({ call }) => call.id === id).length !== 1) return null;
    const results = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'toolResult' && message.toolCallId === id);
    const result = results.length === 1 ? results[0]! : null;
    return result && result.index > after && result.message.toolName === GATEWAY && !hasError(result.message) ? result : null;
  };
  for (const described of calls) {
    const describeArgs = described.call.arguments;
    if (described.index <= errorIndex || described.call.name !== GATEWAY || !object(describeArgs)
      || !exactKeys(describeArgs, ['action', 'operation']) || describeArgs.action !== 'describe' || describeArgs.operation !== OPERATION) continue;
    const description = successfulResult(described.call.id, described.index), descriptionDetails = description?.message.details;
    if (!description || descriptionDetails?.gateway !== GATEWAY || descriptionDetails.action !== 'describe'
      || descriptionDetails.operation !== OPERATION || !object(descriptionDetails.schema)) continue;
    for (const executed of calls) {
      const callArgs = executed.call.arguments;
      if (executed.index <= description.index || executed.call.name !== GATEWAY || !object(callArgs)
        || !exactKeys(callArgs, ['action', 'operation', 'arguments']) || callArgs.action !== 'call' || callArgs.operation !== OPERATION
        || !object(callArgs.arguments) || callArgs.arguments.query !== args.query) continue;
      const result = successfulResult(executed.call.id, executed.index), details = result?.message.details;
      if (details?.gateway === GATEWAY && details.action === 'call' && details.operation === OPERATION
        && object(details.extensionDiscovery) && Array.isArray(details.extensionDiscovery.items)) return 1;
    }
  }
  return fail();
}
