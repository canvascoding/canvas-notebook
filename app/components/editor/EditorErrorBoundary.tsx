'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { captureClientException } from '@/app/lib/observability/capture-client-exception';

interface EditorFailureNoticeProps {
  onRetry: () => void;
}

/** Shared fallback for editor chunks that fail to load and render errors. */
export function EditorFailureNotice({ onRetry }: EditorFailureNoticeProps) {
  const t = useTranslations('common');

  return (
    <div
      className="flex h-full min-h-24 flex-col items-center justify-center gap-3 bg-background px-6 text-center"
      data-testid="editor-error-fallback"
      role="alert"
    >
      <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t('somethingWentWrong')}</p>
        <p className="text-sm text-muted-foreground">{t('pleaseTryAgain')}</p>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {t('retry')}
      </Button>
    </div>
  );
}

interface EditorErrorBoundaryProps {
  children: ReactNode;
  editorKind: string;
  resetKey: string;
}

interface EditorErrorBoundaryState {
  error: Error | null;
}

class EditorErrorBoundaryImpl extends Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  state: EditorErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    captureClientException(error, {
      boundary: 'file-editor-preview',
      componentStack: errorInfo.componentStack,
      tags: { 'editor.kind': this.props.editorKind },
    });
  }

  componentDidUpdate(previousProps: EditorErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) return <EditorFailureNotice onRetry={this.reset} />;
    return this.props.children;
  }
}

/**
 * Keeps a document renderer failure inside the preview pane while retaining
 * the file header and navigation controls.
 */
export function EditorErrorBoundary(props: EditorErrorBoundaryProps) {
  return <EditorErrorBoundaryImpl {...props} />;
}
