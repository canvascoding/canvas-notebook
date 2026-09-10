import { createRoot } from 'react-dom/client';
import { readPublicShareAppData } from '../lib/tool-apps/public-share-data';
import { WidgetField, WidgetShell } from './components';
import { useWidget } from './use-widget';

function PublicShareView() {
  const { data: share, locale, operation, failed, t } = useWidget('Canvas Public Link', readPublicShareAppData);
  if (!share) return <main className="widget-shell" role="status">{t(failed ? 'invalid' : 'loading')}</main>;
  return <WidgetShell title={t(operation === 'create' ? 'shareCreated' : operation === 'revoke' ? 'shareRevoked' : 'shareInspected')}
    status={t(`shareStatus_${share.status}`)}>
    <h1>{share.fileName}</h1><p className="widget-note">{share.workspacePath}</p>
    {share.publicUrl ? <p className="widget-schedule">{share.publicUrl}</p> : null}
    <dl><WidgetField label={t('shareExpires')}>{share.expiresAt
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(share.expiresAt)) : t('shareNoExpiry')}</WidgetField>
      <WidgetField label={t('shareAccesses')}>{new Intl.NumberFormat(locale).format(share.accessCount)}</WidgetField>
      <WidgetField label={t('shareAccess')}>{t(share.passwordEnabled ? 'sharePassword' : 'sharePublic')}</WidgetField></dl>
    <p className="widget-note">{t('currentState')}</p>
  </WidgetShell>;
}
createRoot(document.body.appendChild(document.createElement('div'))).render(<PublicShareView />);
