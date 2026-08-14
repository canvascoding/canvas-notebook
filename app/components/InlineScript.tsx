type InlineScriptProps = {
  html: string;
};

/**
 * Runs while the server-rendered document is parsed, but remains inert during
 * client-side renders. This prevents React from trying to render and execute
 * the script again during a soft navigation.
 */
export function InlineScript({ html }: InlineScriptProps) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
