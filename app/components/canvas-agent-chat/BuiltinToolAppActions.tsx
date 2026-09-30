'use client';

import { AUTOMATION_APP_URI, FILE_CHANGE_APP_URI, TODO_APP_URI, PUBLIC_SHARE_APP_URI, type BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { readAutomationAppData } from '@/app/lib/tool-apps/automation-data';
import { readTodoAppData } from '@/app/lib/tool-apps/todo-data';
import { readPublicShareAppData } from '@/app/lib/tool-apps/public-share-data';
import { PublicShareAppActions } from './PublicShareAppActions';
import { AutomationAppActions } from './AutomationAppActions';
import { FileChangeAppActions } from './FileChangeAppActions';
import { TodoAppActions } from './TodoAppActions';

/** Resource-specific validation and actions stay outside the shared MCP bridge. */
export function BuiltinToolAppActions(props: {
  data: unknown; app: BuiltinToolAppDescriptor; sessionId: string; agentId: string;
  update: (data: Record<string, unknown>) => void; refresh: () => void;
}) {
  if (props.app.resourceUri === AUTOMATION_APP_URI) {
    const data = readAutomationAppData(props.data);
    return data?.id === props.app.entityId ? <AutomationAppActions {...props} data={data} /> : null;
  }
  if (props.app.resourceUri === FILE_CHANGE_APP_URI) {
    return <FileChangeAppActions data={props.data} refresh={props.refresh} />;
  }
  if (props.app.resourceUri === TODO_APP_URI) {
    const data = readTodoAppData(props.data);
    return data?.id === props.app.entityId ? <TodoAppActions {...props} data={data} /> : null;
  }
  if (props.app.resourceUri === PUBLIC_SHARE_APP_URI) {
    const data = readPublicShareAppData(props.data);
    return data?.id === props.app.entityId ? <PublicShareAppActions {...props} data={data} /> : null;
  }
  return null;
}
