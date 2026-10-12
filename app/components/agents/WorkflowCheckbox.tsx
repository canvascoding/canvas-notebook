'use client';

import type { InputHTMLAttributes } from 'react';

/** A native checkbox keeps the workflow controls usable without an additional UI primitive. */
export function WorkflowCheckbox({ onCheckedChange, className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  onCheckedChange: (checked: boolean) => void;
}) {
  return <input {...props} type="checkbox" className={`mt-0.5 size-4 shrink-0 cursor-pointer rounded border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    onChange={event => onCheckedChange(event.target.checked)} />;
}
