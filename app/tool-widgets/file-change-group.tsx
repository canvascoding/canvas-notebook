import { createRoot } from 'react-dom/client';
import {
  FILE_CHANGE_APP_VISIBLE_ENTRIES,
  readFileChangeAppData,
} from '../lib/tool-apps/file-change-data';
import { WidgetShell } from './components';
import { useWidget } from './use-widget';

function FileChangeGroupView() {
  const { data, failed, t } = useWidget('Canvas File Changes', readFileChangeAppData);
  if (!data) return <main className="widget-shell" role="status">{t(failed ? 'invalid' : 'loading')}</main>;
  const visible = data.entries.slice(0, FILE_CHANGE_APP_VISIBLE_ENTRIES);
  const remaining = data.entries.length - visible.length;
  return <WidgetShell title={t(data.operation === 'apply_patch' ? 'fileChangesBatch' : 'fileChanges')}
    status={t(`fileChangeStatus_${data.status}`)}>
    <h1>{data.entries.length === 1 ? data.entries[0]!.pathHint : t('fileChangeFiles', { count: data.entries.length })}</h1>
    <ol className="widget-file-list">
      {visible.map((entry) => <li key={entry.id}>
        <span className={`widget-file-state widget-file-state-${entry.state}`} aria-hidden="true" />
        <span className="widget-file-name" title={entry.pathHint}>{entry.pathHint}</span>
        <span className="widget-file-outcome">{t(`fileChangeStatus_${entry.state}`)}</span>
        {entry.additions !== null || entry.deletions !== null ? <span className="widget-file-diff" aria-label={t('fileChangeDiff', {
          additions: entry.additions ?? 0, deletions: entry.deletions ?? 0,
        })}><b>+{entry.additions ?? 0}</b><i>−{entry.deletions ?? 0}</i></span> : null}
      </li>)}
    </ol>
    {remaining > 0 ? <p className="widget-note">{t('fileChangeMore', { count: remaining })}</p> : null}
    <p className="widget-note">{t('fileChangeCurrentState')}</p>
  </WidgetShell>;
}

createRoot(document.body.appendChild(document.createElement('div'))).render(<FileChangeGroupView />);
