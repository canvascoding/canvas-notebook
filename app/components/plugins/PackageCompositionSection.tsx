'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Search } from 'lucide-react';
import type { PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { CapabilityPackageAuthoringSource } from '@/app/lib/capabilities/packages/authoring-catalog-contracts';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineNotice } from '@/components/ui/inline-notice';
import { PluginExtensionSearchResults } from './PluginExtensionSearchResults';
import { usePluginExtensionSearch } from './usePluginExtensionSearch';
import { workspaceRequest } from './plugin-workspace-client';
import { confirmPluginNavigation } from './plugin-navigation-guard';

type Props = {
  draftRef: string; revision: number; workspaceId?: string | null; disabled: boolean;
  onMutation: (operation: () => Promise<void>) => Promise<void>;
};

/** Authoring chooses readable sources and portable requirements, independently of executable chat selections. */
export function PackageCompositionSection(props: Props) {
  const t = useTranslations('skills.composition');
  const [open, setOpen] = useState(false);
  return <details className="rounded-lg border bg-background" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t('title')}</summary>
    {open ? <div className="space-y-4 border-t p-4"><p className="text-xs leading-relaxed text-muted-foreground">{t('description')}</p>
      <PackageCompositionPicker key={JSON.stringify([props.workspaceId, props.draftRef, props.revision])} {...props} />
    </div> : null}
  </details>;
}

function PackageCompositionPicker({ draftRef, revision, workspaceId, disabled, onMutation }: Props) {
  const t = useTranslations('skills.composition'), catalog = useTranslations('skills.workspace.catalog');
  const [text, setText] = useState(''), [query, setQuery] = useState('');
  const [kind, setKind] = useState<NonNullable<PluginNavigation['kind']>>('all'), [cursor, setCursor] = useState<string>();
  const [selection, setSelection] = useState<{ key: string; item: PluginExtensionItem } | null>(null);
  const [source, setSource] = useState<{ key: string; data?: CapabilityPackageAuthoringSource; error?: boolean } | null>(null);
  const [inspectionAttempt, setInspectionAttempt] = useState(0), [targetNames, setTargetNames] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]), [connector, setConnector] = useState(''), [required, setRequired] = useState(true);
  useEffect(() => { const timer = setTimeout(() => { setQuery(text); setCursor(undefined); }, 250); return () => clearTimeout(timer); }, [text]);
  const navigation: PluginNavigation = { area: 'plugins', view: 'browse', scope: 'all', kind, stock: 'all', q: query, extensionCursor: cursor };
  const data = usePluginExtensionSearch({ navigation, workspaceId: workspaceId ?? null, epoch: 0 });
  const item = selection?.key === data.key ? selection.item : null;
  const inspectionKey = JSON.stringify([workspaceId, draftRef, revision, data.key, item?.id, inspectionAttempt]);
  const current = useRef(inspectionKey);
  useLayoutEffect(() => { current.current = inspectionKey; return () => { current.current = ''; }; }, [inspectionKey]);
  const resourceRef = item && (item.kind === 'plugin' || item.kind === 'skill') ? item.package?.resourceRef : undefined;
  useEffect(() => {
    if (!resourceRef) return;
    const controller = new AbortController();
    void workspaceRequest<CapabilityPackageAuthoringSource>(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/authoring-source`, workspaceId ?? null,
      { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted && current.current === inspectionKey) setSource({ key: inspectionKey, data: response });
    }).catch(() => { if (!controller.signal.aborted && current.current === inspectionKey) setSource({ key: inspectionKey, error: true }); });
    return () => controller.abort();
  }, [inspectionKey, resourceRef, workspaceId]);
  const inspected = source?.key === inspectionKey ? source : null;
  const select = (next: PluginExtensionItem) => {
    if (disabled) return;
    setSelection({ key: data.key, item: next }); setInspectionAttempt(value => value + 1); setChosen([]); setTargetNames({}); setConnector(''); setRequired(true);
  };
  const addSkills = () => {
    const selected = inspected?.data?.skills.filter(skill => chosen.includes(skill.name));
    if (!selected?.length || disabled) return;
    void onMutation(async () => {
      await workspaceRequest(`/api/capabilities/packages/drafts/${encodeURIComponent(draftRef)}/compose-skills`, workspaceId ?? null,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDraftRevision: revision,
          skills: selected.map(skill => ({ source: skill.source, ...(targetNames[skill.name] && targetNames[skill.name] !== skill.name ? { targetName: targetNames[skill.name] } : {}) })) }) });
    });
  };
  const addRequirement = () => {
    if (!item || !['integration', 'mcp'].includes(item.kind) || disabled) return;
    void onMutation(async () => {
      await workspaceRequest(`/api/capabilities/packages/drafts/${encodeURIComponent(draftRef)}/requirements`, workspaceId ?? null,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDraftRevision: revision,
          catalogId: item.id, required, ...(item.kind === 'mcp' ? { connectorName: connector } : {}) }) });
    });
  };
  const offering = item && (item.kind === 'plugin' || item.kind === 'skill') ? item.offering : undefined;
  const availableVersion = offering?.versions.find(version => version.version === offering.latestVersion);
  const storeQuery = offering && availableVersion ? new URLSearchParams({ area: offering.kind === 'skill' ? 'skills' : 'plugins',
    view: offering.kind === 'skill' ? 'library' : 'discover', source: 'store', [offering.kind === 'skill' ? 'skill' : 'plugin']: offering.entryKey,
    storeRegistryId: offering.registryId, storeVersion: availableVersion.version, storeChecksum: availableVersion.checksum,
    ...(workspaceId ? { workspaceId } : {}) }) : null;
  return <section className="min-w-0 space-y-4" aria-label={t('title')} aria-busy={disabled} data-testid="package-composition-picker">
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input value={text} onChange={event => { setText(event.target.value); setSelection(null); setChosen([]); }} className="pl-9" disabled={disabled} aria-label={t('search')} placeholder={t('search')} />
    </div>
    <div className="flex flex-wrap gap-1" aria-label={t('filter')}>
      {(['all', 'plugin', 'skill', 'integration', 'mcp'] as const).map(value => <Button type="button" size="sm" key={value}
        variant={kind === value ? 'secondary' : 'ghost'} aria-pressed={kind === value} disabled={disabled}
        onClick={() => { setKind(value); setCursor(undefined); setSelection(null); setChosen([]); }}>{catalog(value === 'all' ? 'kind_all' : `kind_${value}`)}</Button>)}
    </div>
    {item ? <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-label={t('selection')}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-medium">{item.displayName}</h4>
        <p className="mt-1 break-words text-xs text-muted-foreground">{item.description}</p></div>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setSelection(null)}>{t('clear')}</Button></div>
      {resourceRef ? inspected?.error ? <InlineNotice size="compact" variant="warning" actions={<Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setChosen([]); setInspectionAttempt(value => value + 1); }}>{catalog('retry')}</Button>}>{t('sourceError')}</InlineNotice>
        : !inspected?.data ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>
          : <><p className="text-xs text-muted-foreground">{t('sourceHint')}</p>
            {!inspected.data.skills.length ? <p role="status" className="text-xs text-muted-foreground">{t('noVersionedSkills')}</p> : null}
            <ul className="space-y-2">{inspected.data.skills.map(skill => <li key={skill.name}>
              <Label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={chosen.includes(skill.name)} disabled={disabled}
                onChange={event => setChosen(previous => event.target.checked ? [...previous, skill.name] : previous.filter(name => name !== skill.name))} />
                <span className="min-w-0 break-words">{skill.title}<span className="ml-2 text-xs font-normal text-muted-foreground">{skill.version}</span></span></Label>
            </li>)}</ul>
            {chosen.length ? <details className="rounded-md border p-3"><summary className="cursor-pointer text-xs font-medium">{t('namesTitle')}</summary>
              <div className="mt-3 grid gap-3">{inspected.data.skills.filter(skill => chosen.includes(skill.name)).map(skill => <Label key={skill.name} className="grid gap-1 text-xs">
                {t('targetName', { name: skill.title })}<Input value={targetNames[skill.name] ?? skill.name} maxLength={64} disabled={disabled}
                  onChange={event => setTargetNames(previous => ({ ...previous, [skill.name]: event.target.value }))} /></Label>)}</div>
            </details> : null}
            {chosen.length > 32 ? <p role="status" className="text-xs text-muted-foreground">{t('batchLimit')}</p> : null}
            <Button type="button" size="sm" disabled={disabled || !chosen.length || chosen.length > 32 || chosen.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(targetNames[name] ?? name))} onClick={addSkills}><Plus className="size-4" />{t('addSkills', { count: chosen.length })}</Button></>
        : storeQuery ? <><p className="text-xs text-muted-foreground">{t('installFirst')}</p><Link className="text-sm underline underline-offset-4" href={`/plugins?${storeQuery}`}
          onClick={event => { if (disabled || !confirmPluginNavigation()) event.preventDefault(); }}>{t('openStore')}</Link></> : null}
      {item.kind === 'integration' || item.kind === 'mcp' ? <>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('requirementHint')}</p>
        {item.kind === 'mcp' ? <Label className="grid gap-2 text-xs">{t('connectorName')}<Input value={connector} disabled={disabled} maxLength={64}
          placeholder="company-research" onChange={event => setConnector(event.target.value)} /></Label> : null}
        <Label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={required} disabled={disabled}
          onChange={event => setRequired(event.target.checked)} />{t('required')}</Label>
        <Button type="button" size="sm" onClick={addRequirement} disabled={disabled || item.kind === 'mcp' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(connector)}>
          <Plus className="size-4" />{t('addRequirement')}</Button></> : null}
    </section> : null}
    <PluginExtensionSearchResults data={data} workspaceId={workspaceId} onOpen={select} onMore={setCursor} onRetry={() => { setSelection(null); setChosen([]); data.retry(); }} />
  </section>;
}
