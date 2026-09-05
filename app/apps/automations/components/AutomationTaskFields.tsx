'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditorClient';
import { AutomationAgentPicker, type AutomationAgentOption } from './AutomationAgentPicker';

export type AutomationTaskValues = { name: string; prompt: string; agentId: string };

export function AutomationTaskFields({
  value,
  agents,
  onChange,
  workspace,
  testId,
}: {
  value: AutomationTaskValues;
  agents: AutomationAgentOption[];
  onChange: (patch: Partial<AutomationTaskValues>) => void;
  workspace: ReactNode;
  testId: string;
}) {
  const t = useTranslations('automationen');
  const scheduled = testId === 'scheduled';
  return (
    <div className="space-y-5" data-testid={`automation-${testId}-task-fields`}>
      {workspace}
      <label className="block space-y-2 text-sm font-medium">
        <span>{t('editor.fields.name')}</span>
        <input
          data-testid={scheduled ? 'automation-name' : undefined}
          className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base font-medium"
          value={value.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t('editor.placeholders.name')}
        />
      </label>
      <AutomationAgentPicker
        agents={agents}
        value={value.agentId}
        onChange={(agentId) => onChange({ agentId })}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('ux.task')}</p>
        <div
          className="h-56 min-h-48 min-w-0 overflow-hidden rounded-md border border-input bg-background"
          data-testid={scheduled ? 'automation-prompt' : undefined}
        >
          <MarkdownEditor
            value={value.prompt}
            onChange={(prompt) => onChange({ prompt })}
            externalValueSync="when-blurred"
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('ux.pathHint')}</p>
      </div>
    </div>
  );
}
