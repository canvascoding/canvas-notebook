'use client';

import React, { useState } from 'react';

// Regex patterns for color detection
const HEX_REGEX = /^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const RGB_REGEX = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/;
const RGBA_REGEX = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/;
const HSL_REGEX = /^hsl\(\s*\d+\s*,\s*\d+%?\s*,\s*\d+%?\s*\)$/;
const HSLA_REGEX = /^hsla\(\s*\d+\s*,\s*\d+%?\s*,\s*\d+%?\s*,\s*[\d.]+\s*\)$/;

export const COLOR_REGEX = new RegExp(
  `(${HEX_REGEX.source.slice(1, -1)}|${RGB_REGEX.source.slice(1, -1)}|${RGBA_REGEX.source.slice(1, -1)}|${HSL_REGEX.source.slice(1, -1)}|${HSLA_REGEX.source.slice(1, -1)})`,
  'i'
);

export function isColorCode(str: string): boolean {
  const trimmed = str.trim();
  return HEX_REGEX.test(trimmed) || 
         RGB_REGEX.test(trimmed) || 
         RGBA_REGEX.test(trimmed) || 
         HSL_REGEX.test(trimmed) || 
         HSLA_REGEX.test(trimmed);
}

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
    <span className="inline-flex items-center gap-1">
      <code className="text-xs">{color}</code>
      <span
        style={swatchStyle}
        onClick={handleClick}
        title={copied ? 'Copied!' : 'Click to copy'}
      />
    </span>
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
