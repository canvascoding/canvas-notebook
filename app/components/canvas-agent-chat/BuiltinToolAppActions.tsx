'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { AUTOMATION_APP_URI, TODO_APP_URI, type BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { readAutomationAppData } from '@/app/lib/tool-apps/automation-data';
import { readTodoAppData } from '@/app/lib/tool-apps/todo-data';
import { AutomationAppActions } from './AutomationAppActions';

/** Resource-specific validation and actions stay outside the shared MCP bridge. */
export function BuiltinToolAppActions(props: {
  data: unknown; app: BuiltinToolAppDescriptor; sessionId: string; agentId: string;
  update: (data: Record<string, unknown>) => void; refresh: () => void;
}) {
  const t = useTranslations('chat.toolApp');
  if (props.app.resourceUri === AUTOMATION_APP_URI) {
    const data = readAutomationAppData(props.data);
    return data?.id === props.app.entityId ? <AutomationAppActions {...props} data={data} /> : null;
  }
  if (props.app.resourceUri === TODO_APP_URI) {
    const data = readTodoAppData(props.data);
    if (!data || data.id !== props.app.entityId) return null;
    return <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
      <Button size="xs" variant="outline" asChild><Link href={`/todos?todo=${encodeURIComponent(data.id)}`}>
        {t(data.status === 'open' ? 'todoReview' : 'open')}
      </Link></Button>
      <Button size="xs" variant="ghost" onClick={props.refresh}>{t('reload')}</Button>
    </div>;
  }
  return null;
}
