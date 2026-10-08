/** Only capabilities available in this turn may be mentioned in recipient guidance. */
export function buildEmailRecipientDiscoveryGuidance(hasCapability: (name: string) => boolean): string | null {
  if (!hasCapability('email_recipients')) return null;
  const lines = ['For recipient research use email_recipients: search, describe one permitted operation, then call.'];
  if (hasCapability('email_find_recipients')) {
    lines.push('Look up names in the selected mailbox before guessing. Ask the user to choose ambiguous candidates; incomplete coverage never proves a unique identity.');
  }
  if (hasCapability('email_suggest_reply_recipients')) {
    lines.push('Reply suggestions use only the selected message. Additional participants require user selection; never add them automatically.');
  }
  lines.push('Keep source references visible when proposing an address. Prepare a draft for human review; do not claim that email was sent.');
  return lines.join(' ');
}
