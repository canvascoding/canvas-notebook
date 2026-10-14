'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { ExtensionConnectionChooser, type AgentExtensionChosenConnection } from '@/app/components/agents/AgentExtensionConnectionChooser';
import { activeExtensionDeclarations, emptyAgentExtensionConfiguration, extensionAlternativeKey } from '@/app/components/agents/agent-extension-editor-draft';
import type { AgentExtensionPackageVersion, AgentExtensionConfigurationConnectionSelector } from '@/app/lib/agents/extension-options-contracts';
import { requestChatExtensionOptions } from '@/app/lib/chat/extension-options-client';
import type { ChatReferenceDialogRequest } from '@/app/lib/chat/composer-reference-types';
import { deriveChatBodySelection, parseChatBody, type ChatReferenceBundleV1 } from '@/app/lib/chat/chat-body-contracts';
import { chatInlineReferenceIconKey } from '@/app/lib/chat/inline-editor';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import type { ChatExtensionSelectionInput, ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';

type Props = { request: ChatReferenceDialogRequest; onClose: () => void;
  onSelect: (bundle: ChatReferenceBundleV1, intake: ChatExtensionSelectionInput | null,
    receiptExpiries?: Readonly<Record<string, number>>) => void };
type Chosen = AgentExtensionChosenConnection;
type Binding = { alternativeKey: string; choice: Chosen };
type SupportingEntry = ChatReferenceBundleV1['supporting'][number];

export function ChatExtensionReferenceDialog(props: Props) {
  const auth = useSyncExternalStore(subscribeOpenedDocumentAuthInvalidation, openedDocumentAuthScope, () => null);
  const scope = JSON.stringify([auth?.userId, auth?.sessionId, auth?.epoch, props.request.target]);
  if (scope !== props.request.issuedScope) return null;
  const key = JSON.stringify([props.request.issuedScope, props.request.target, props.request.option?.item.id, props.request.recent?.bodyBundle.id,
    props.request.confirmSelection ?? null, props.request.range]);
  return <ReferenceDialogSession key={key} {...props} />;
}

/** A selection dialog builds public intent. Only ordinary send admission grants an actual turn. */
function ReferenceDialogSession({ request, onClose, onSelect }: Props) {
  const locale = useLocale(), copy = (de: string, en: string) => locale.startsWith('de') ? de : en;
  const recentBundle = request.recent?.bodyBundle;
  const initial = request.confirmSelection ?? recentBundle?.primary.selection ?? request.option?.selection ?? null;
  const [selection, setSelection] = useState<ExtensionSelection | null>(initial);
  const [standalone, setStandalone] = useState<Chosen | null>(null);
  const [metadata, setMetadata] = useState<AgentExtensionPackageVersion | null>(null);
  const [bindings, setBindings] = useState<Record<string, Binding>>(() => Object.fromEntries((recentBundle?.packageConnections ?? []).map(mapping =>
    [JSON.stringify([mapping.declarationPath, mapping.capabilityId]), { alternativeKey: mapping.alternativeKey,
      choice: { selection: mapping.connectionSelection, label: mapping.connectionSelection.kind === 'composio' ? mapping.connectionSelection.toolkit : 'MCP' } }])));
  const [alternatives, setAlternatives] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [receiptNow, setReceiptNow] = useState(() => Date.now());
  const alive = useRef(true), submitting = useRef(false);
  const [bundleId] = useState(() => crypto.randomUUID());
  const item = request.option?.item;
  const title = request.confirmSelection ? copy('Konto bestätigen', 'Confirm account')
    : item?.displayName ?? recentBundle?.caption ?? copy('Referenz auswählen', 'Choose reference');
  const scope = request.issuedScope;
  const pin = selection?.kind === 'plugin' || selection?.kind === 'skill' ? selection.package : null;
  const pinKey = JSON.stringify(pin);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => setReceiptNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!pin) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(true); setError(null);
      void requestChatExtensionOptions({ operation: 'package_version', target: request.target, ...pin }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setMetadata(result.package); })
        .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); })
        .finally(() => { if (!controller.signal.aborted) setPending(false); });
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // The dialog session is keyed to the original target and exact immutable pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, retry]);
  const configuration = { ...emptyAgentExtensionConfiguration(), selections: selection ? [{ selection, requirement: 'required' as const, toolCap: null }] : [] };
  const declarations = metadata && pin ? activeExtensionDeclarations(configuration, metadata) : [];
  const requirements = declarations.flatMap(declaration => declaration.workflow.integrationCapabilities.map(capability => ({
    declarationPath: declaration.declarationPath, capability, key: JSON.stringify([declaration.declarationPath, capability.id]),
  })));
  const primarySelector = useMemo<AgentExtensionConfigurationConnectionSelector | null>(() => {
    if (selection?.kind === 'composio') return { kind: 'standalone', source: 'composio', toolkit: selection.toolkit };
    if (selection?.kind === 'mcp') return { kind: 'standalone', source: 'mcp' };
    if (item?.kind === 'integration') return { kind: 'standalone', source: 'composio', toolkit: item.toolkit.slug };
    if (item?.kind === 'mcp') return { kind: 'standalone', source: 'mcp' };
    return null;
  }, [selection, item]);
  const makeProvider = (selector: AgentExtensionConfigurationConnectionSelector) => ({
    key: JSON.stringify([scope, selector]), workspaceId: request.target.kind === 'turn' ? request.target.expectedWorkspaceId : request.target.workspaceId,
    purpose: 'chat' as const,
    load: (query: { q: string; profileId?: string; cursor: string | null; limit: number }, signal: AbortSignal) =>
      requestChatExtensionOptions({ operation: 'connection_choices', target: request.target, selector, ...query }, signal),
  });
  const accountNeedsReceipt = (choice: Chosen | null | undefined, now = receiptNow) => Boolean(choice && choice.selection.kind === 'composio'
    && choice.selection.target.kind === 'personal' && choice.selection.target.accountBinding === 'account'
    && (!choice.accountSelectionRef || !choice.accountSelectionExpiresAt || !(Date.parse(choice.accountSelectionExpiresAt) > now)));
  const missing = requirements.some(row => row.capability.required && !bindings[row.key]
    || accountNeedsReceipt(bindings[row.key]?.choice));
  const unavailable = request.option?.eligibility.action === 'setup' || request.option?.eligibility.action === 'unavailable'
    || request.recent?.eligibility.action === 'setup' || request.recent?.eligibility.action === 'unavailable';
  const selectedStandalone = selection?.kind === 'mcp' || selection?.kind === 'composio';
  const canAdd = !unavailable && !pending && selection !== null && (!pin || metadata !== null)
    && !missing && (!selectedStandalone || standalone !== null && !accountNeedsReceipt(standalone));
  const confirm = async () => {
    if (!canAdd || !selection || submitting.current) return;
    submitting.current = true; setPending(true); setError(null);
    try {
      // This fresh clock is read only by the explicit confirmation click, never during render.
      // eslint-disable-next-line react-hooks/purity
      if (accountNeedsReceipt(standalone, Date.now()) || requirements.some(row => accountNeedsReceipt(bindings[row.key]?.choice, Date.now())))
        throw new Error(copy('Bitte dasselbe Konto erneut wählen.', 'Choose the same account again.'));
      const supporting = new Map<string, SupportingEntry>(), receipts = new Map<string, string>();
      const receiptExpiries: Record<string, number> = {};
      const packageConnections = requirements.flatMap(row => {
        const binding = bindings[row.key]; if (!binding || !pin) return [];
        const key = chatInlineReferenceIconKey(binding.choice.selection), prior = supporting.get(key);
        const previous = recentBundle?.supporting.find(entry => chatInlineReferenceIconKey(entry.selection) === key);
        supporting.set(key, { selection: binding.choice.selection, requirement: row.capability.required || prior?.requirement === 'required' ? 'required' : 'optional', toolCap: previous?.toolCap ?? null });
        if (binding.choice.accountSelectionRef) {
          receipts.set(key, binding.choice.accountSelectionRef);
          receiptExpiries[key] = Date.parse(binding.choice.accountSelectionExpiresAt ?? '');
        }
        return [{ package: pin, declarationPath: row.declarationPath, capabilityId: row.capability.id,
          alternativeKey: binding.alternativeKey, connectionSelection: binding.choice.selection }];
      });
      if (standalone?.accountSelectionRef) {
        const key = chatInlineReferenceIconKey(standalone.selection);
        receipts.set(key, standalone.accountSelectionRef);
        receiptExpiries[key] = Date.parse(standalone.accountSelectionExpiresAt ?? '');
      }
      const child = selection.kind === 'skill' ? metadata?.children.find(row => row.relativeRoot === selection.relativeRoot) : undefined;
      const caption = standalone && !pin ? `${item?.displayName ?? (selection.kind === 'composio' ? selection.toolkit : 'MCP')} · ${standalone.label}`
        : recentBundle?.caption ?? child?.title ?? child?.name ?? metadata?.displayName ?? title;
      const bundle: ChatReferenceBundleV1 = { id: bundleId, caption, primary: { selection,
        requirement: recentBundle?.primary.requirement ?? 'required', toolCap: recentBundle?.primary.toolCap ?? null },
        supporting: [...supporting.values()], packageConnections };
      const body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: crypto.randomUUID(), bundleId }], bundles: [bundle] });
      const publicSelection = deriveChatBodySelection(body)!;
      const intake: ChatExtensionSelectionInput = { ...publicSelection, selections: publicSelection.selections.map(entry => {
        const receipt = receipts.get(chatInlineReferenceIconKey(entry.selection));
        return receipt ? { ...entry, accountSelectionRef: receipt } : entry;
      }) };
      const result = await requestChatExtensionOptions({ operation: 'preview', target: request.target, body, intakeSelection: intake });
      if (!alive.current) return;
      const issue = result.preview.issues.find(row => row.severity === 'error');
      if (issue || result.preview.configurationReadiness === 'blocked' || result.preview.configurationReadiness === 'incomplete')
        throw new Error(issue?.message ?? copy('Die Auswahl ist noch unvollständig.', 'This selection is incomplete.'));
      if (Object.values(receiptExpiries).some(expiry => !Number.isFinite(expiry) || expiry <= Date.now()))
        throw new Error(copy('Die Konto-Bestätigung ist abgelaufen. Bitte dasselbe Konto erneut wählen.', 'The account confirmation expired. Choose the same account again.'));
      onSelect(bundle, intake, receiptExpiries);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; if (alive.current) setPending(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl" data-testid="chat-extension-reference-dialog">
    <DialogHeader><DialogTitle className="flex items-center gap-3"><PluginExtensionAvatar size="sm" name={title}
      identity={JSON.stringify([scope, pin ?? selection ?? item?.id])} icon={metadata?.icon ?? item?.icon ?? request.recent?.publicIcon} />{title}</DialogTitle>
      <DialogDescription>{request.confirmSelection ? copy('Bestätige dasselbe Konto für diese Nachricht.', 'Confirm the same account for this message.')
        : copy('Wähle die Bestandteile und bei Bedarf die Verbindung. Danach wird die Referenz in deinen Text eingefügt.', 'Choose its components and connection when needed. The reference is then inserted into your text.')}</DialogDescription></DialogHeader>
    {unavailable ? <div className="space-y-3"><p className="text-sm text-muted-foreground">{request.option?.eligibility.reason?.message ?? request.recent?.eligibility.reason?.message}</p>
      <Button asChild variant="outline"><a href={`/${locale}/plugins`}>{copy('Plugins öffnen', 'Open plugins')}</a></Button></div> : null}
    {metadata ? <div className="space-y-4"><p className="text-sm text-muted-foreground">{metadata.description}</p>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{copy('Enthaltene Skills', 'Included skills')} · {metadata.children.length}</summary>
        <div className="mt-3 space-y-2">{metadata.children.map(child => {
          const selected = selection?.kind === 'plugin' && (selection.skillSelection.kind === 'all' || selection.skillSelection.relativeRoots.includes(child.relativeRoot))
            || selection?.kind === 'skill' && selection.relativeRoot === child.relativeRoot;
          return <label className="flex items-start gap-2 rounded-md p-2 hover:bg-muted/50" key={child.relativeRoot}>
            <input type="checkbox" checked={selected || child.required} disabled={pending || child.required || selection?.kind !== 'plugin'}
              onChange={event => { if (selection?.kind !== 'plugin') return;
                const roots = new Set(selection.skillSelection.kind === 'all' ? metadata.children.map(row => row.relativeRoot) : selection.skillSelection.relativeRoots);
                if (event.target.checked) roots.add(child.relativeRoot); else roots.delete(child.relativeRoot);
                metadata.children.filter(row => row.required).forEach(row => roots.add(row.relativeRoot));
                setSelection({ ...selection, skillSelection: { kind: 'subset', relativeRoots: [...roots] } }); }} />
            <PluginExtensionAvatar size="sm" name={child.title ?? child.name} identity={JSON.stringify([scope, metadata.pin, child.relativeRoot])} icon={child.icon} />
            <span className="min-w-0 text-sm"><span className="font-medium">{child.title ?? child.name}</span><span className="block text-xs text-muted-foreground">{child.description}</span></span>
          </label>;
        })}</div>
      </details>
      {requirements.map(row => {
        const binding = bindings[row.key], alternative = alternatives[row.key] ?? binding?.alternativeKey ?? extensionAlternativeKey(row.capability.alternatives[0]);
        const selector: AgentExtensionConfigurationConnectionSelector = { kind: 'package', package: metadata.pin,
          declarationPath: row.declarationPath, capabilityId: row.capability.id, alternativeKey: alternative };
        return <details className="rounded-lg border p-3" open={!binding && row.capability.required || undefined} key={row.key}>
          <summary className="cursor-pointer text-sm"><span className="capitalize font-medium">{row.capability.application}</span><span className="ml-2 text-xs text-muted-foreground">{binding?.choice.label ?? (row.capability.required ? copy('Verbindung erforderlich', 'Connection required') : copy('Optional', 'Optional'))}</span></summary>
          <div className="mt-3 space-y-3">{row.capability.alternatives.length > 1 ? <select className="w-full rounded-md border bg-background p-2 text-sm" value={alternative}
            aria-label={copy('Verbindungsart', 'Connection type')} disabled={pending} onChange={event => {
              setAlternatives(current => ({ ...current, [row.key]: event.target.value }));
              setBindings(current => { const next = { ...current }; delete next[row.key]; return next; });
            }}>{row.capability.alternatives.map(item => <option key={extensionAlternativeKey(item)} value={extensionAlternativeKey(item)}>{item.source === 'composio' ? item.toolkit : item.connector}</option>)}</select> : null}
            <ExtensionConnectionChooser provider={makeProvider(selector)} disabled={pending} onSelect={choice => setBindings(current => ({ ...current, [row.key]: { alternativeKey: alternative, choice } }))} />
            {binding && !row.capability.required ? <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setBindings(current => { const next = { ...current }; delete next[row.key]; return next; })}>{copy('Ohne diese Verbindung', 'Without this connection')}</Button> : null}
          </div></details>;
      })}
    </div> : null}
    {!unavailable && primarySelector ? <ExtensionConnectionChooser provider={makeProvider(primarySelector)} disabled={pending}
      lockedSelection={request.confirmSelection?.kind === 'composio' || request.confirmSelection?.kind === 'mcp' ? request.confirmSelection
        : initial?.kind === 'mcp' ? initial : undefined}
      onSelect={choice => { setSelection(choice.selection); setStandalone(choice); setError(null); }} /> : null}
    {standalone ? <p className="text-sm text-muted-foreground">{copy('Gewählt', 'Selected')}: {standalone.label}</p> : null}
    {accountNeedsReceipt(standalone) || requirements.some(row => accountNeedsReceipt(bindings[row.key]?.choice))
      ? <p role="status" className="text-sm text-muted-foreground">{copy('Bitte das genaue Konto erneut bestätigen. Bei abgelaufener Auswahl die Verbindungen aktualisieren.', 'Confirm the exact account again. Refresh the connections if the choice expired.')}</p> : null}
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{pin && !metadata ? <Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>{copy('Erneut laden', 'Reload')}</Button> : null}</div> : null}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>{copy('Abbrechen', 'Cancel')}</Button>
      <Button type="button" disabled={!canAdd} onClick={() => void confirm()}>{pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        {request.confirmSelection ? copy('Konto bestätigen', 'Confirm account') : copy('In Text einfügen', 'Insert into text')}</Button></div>
  </DialogContent></Dialog>;
}
