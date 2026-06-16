'use client';

import React, { useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
export { COLOR_REGEX, INLINE_HEX_REGEX, isColorCode } from './color-code';

interface ColorSwatchProps {
  color: string;
}

export function ColorSwatch({ color }: ColorSwatchProps) {
  const [copied, setCopied] = useState(false);
  
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(color.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent fail - clipboard API not available
    }
  };

  const swatchStyle: React.CSSProperties = {
    backgroundColor: color.trim(),
    width: '14px',
    height: '14px',
    borderRadius: '2px',
    border: '1px solid rgba(0,0,0,0.2)',
    display: 'inline-block',
    marginLeft: '4px',
    cursor: 'pointer',
    verticalAlign: 'middle',
  };

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 cursor-pointer" onClick={handleClick}>
            <code className="text-xs">{color}</code>
            <span style={swatchStyle} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copied ? 'Kopiert!' : 'Kopieren'}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Component for markdown-to-html (static version without clipboard)
export function ColorSwatchStatic({ color }: ColorSwatchProps) {
  const swatchStyle: React.CSSProperties = {
    backgroundColor: color.trim(),
    width: '14px',
    height: '14px',
    borderRadius: '2px',
    border: '1px solid rgba(0,0,0,0.2)',
    display: 'inline-block',
    marginLeft: '4px',
    verticalAlign: 'middle',
  };

  return (
    <span className="inline-flex items-center gap-1">
      <code className="text-xs">{color}</code>
      <span style={swatchStyle} />
    </span>
  );
}
