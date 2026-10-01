export type TodoStatus = 'open' | 'done' | 'archived';
export type TodoPriority = 'low' | 'normal' | 'high';
export type TodoSourceType = 'user' | 'agent';
export type TodoScopeKind = 'user' | 'workspace';
export type TodoListScope = 'personal' | 'workspace' | 'global';
export type StatusFilter = TodoStatus | 'all';

export type TodoCategory = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  isArchived: boolean;
  sortOrder: number;
};

export type TodoFileLink = {
  id: string;
  workspaceId: string | null;
  workspaceType: TodoWorkspaceType;
  workspacePath: string;
  label: string | null;
};

export type TodoWorkspaceType = 'personal' | 'organization' | 'team' | 'project';

export type TodoUserSummary = {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
};

export type AssigneeOption = TodoUserSummary & {
  role?: string | null;
};

export type TodoItem = {
  id: string;
  canWrite: boolean;
  createdByUserId: string | null;
  assigneeUserId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: TodoWorkspaceType;
  scopeKind: TodoScopeKind;
  workspace: { id: string; name: string; type: TodoWorkspaceType } | null;
  title: string;
  description: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  iconKey: TodoIconKey | null;
  sourceType: TodoSourceType;
  sourceSessionId: string | null;
  dueAt: string | null;
  remindAt: string | null;
  completedAt: string | null;
  completionComment: string | null;
  followUpSentAt: string | null;
  followUpError: string | null;
  emailNotificationSentAt: string | null;
  emailNotificationError: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  category: TodoCategory | null;
  fileLinks: TodoFileLink[];
  createdBy: TodoUserSummary | null;
  assignee: TodoUserSummary | null;
};

export type WorkspaceOption = {
  id: string;
  type: TodoWorkspaceType | 'project';
  name: string;
  organizationId: string | null;
  permissions?: {
    canRead?: boolean;
    canWrite?: boolean;
  };
};

export type TodoFormState = {
  title: string;
  description: string;
  categoryId: string;
  priority: TodoPriority;
  iconKey: TodoIconKey | '';
  dueAt: string;
  remindAt: string;
  assigneeUserId: string;
  fileLinks: Array<{ workspacePath: string; label: string | null }>;
};

export type TodoIconKey = 'check' | 'eye' | 'approval' | 'message' | 'file' | 'calendar' | 'warning' | 'idea' | 'user' | 'settings';
