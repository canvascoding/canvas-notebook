'use client';

import { useEffect, useState } from 'react';
import { CircleAlert, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import type { AgentExtensionConfigurationTarget, AgentExtensionPackageVersion } from '@/app/lib/agents/extension-options-contracts';
import type { AgentWorkflowPackageConfiguration } from '@/app/lib/agents/workflow-public-contracts';
import type { AgentWorkflowManagementBindingSummary } from '@/app/lib/agents/workflow-management-contracts';
import type { ExtensionSelectionInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';
import { AgentExtensionCapabilityEditor } from './AgentExtensionCapabilityEditor';
import { activeExtensionDeclarations, extensionPinKey, selectedExtensionRoots, type FixedAgentExtensionConfiguration } from './agent-extension-editor-draft';
import { agentExtensionEditorContextKey, requestAgentExtensionOptions } from './agent-extension-options-client';
import { AgentExtensionToolCapEditor } from './AgentExtensionToolCapEditor';
import { WorkflowCheckbox } from './WorkflowCheckbox';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';

type Props = { configuration: FixedAgentExtensionConfiguration; pkg: AgentWorkflowPackageConfiguration;
  target: AgentExtensionConfigurationTarget; context: AgentExtensionEditorContext; initialMetadata?: AgentExtensionPackageVersion;
  bindingSummaries?: readonly AgentWorkflowManagementBindingSummary[];
  disabled?: boolean; onChange: (configuration: FixedAgentExtensionConfiguration) => void };

/** Holds the immutable published pin; mutable heads and readable names never select children. */
export function AgentExtensionPackageEditor(props: Props) {
  return <PackageEditorSession key={agentExtensionEditorContextKey(props.context, props.target) + extensionPinKey(props.pkg)} {...props} />;
}
function PackageEditorSession({ configuration, pkg, target, context, initialMetadata, disabled, onChange, bindingSummaries }: Props) {
  const copy = useAgentExtensionCopy(), [metadata, setMetadata] = useState(initialMetadata), [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(!initialMetadata), [retry, setRetry] = useState(0);
  const key = extensionPinKey(pkg);
  useEffect(() => {
    if (metadata && !retry) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setPending(true); setError(null); } });
    void requestAgentExtensionOptions(context, { operation: 'package_version', target, resourceRef: pkg.resourceRef,
      publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (extensionPinKey(result.package.pin) !== key) throw new Error(copy('Die Paketversion wurde verändert.', 'The package version changed.'));
      setMetadata(result.package);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
    // The keyed session pins actor, target and immutable source. Metadata never restarts on form edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const entries = configuration.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
    && extensionPinKey(entry.selection.package) === key);
  const parent = entries.find(entry => entry.selection.kind === 'plugin');
  const roots = metadata ? selectedExtensionRoots(configuration, metadata) : [];
  const changePackage = (next: AgentWorkflowPackageConfiguration) => onChange({ ...configuration, workflow: { version: 1,
    packages: (configuration.workflow?.packages ?? []).map(value => value.resourceRef === pkg.resourceRef ? next : value) } });
  const changeRoots = (root: string, checked: boolean) => {
    if (!metadata) return;
    const nextRoots = new Set(roots); if (checked) nextRoots.add(root); else nextRoots.delete(root);
    metadata.children.filter(child => child.required).forEach(child => nextRoots.add(child.relativeRoot));
    if (!parent && !nextRoots.size) return;
    const other = configuration.selections.filter(entry => !(entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
      || extensionPinKey(entry.selection.package) !== key);
    const nextEntries: ExtensionSelectionInput[] = parent ? entries.filter(entry => entry.selection.kind === 'plugin'
      || entry.selection.kind === 'skill' && nextRoots.has(entry.selection.relativeRoot)).map(entry => entry.selection.kind === 'plugin'
      ? { ...entry, selection: { ...entry.selection, skillSelection: { kind: 'subset', relativeRoots: [...nextRoots] } } } : entry)
      : [...nextRoots].map(relativeRoot => entries.find(entry => entry.selection.kind === 'skill' && entry.selection.relativeRoot === relativeRoot)
        ?? { selection: { kind: 'skill', package: metadata.pin, origin: metadata.kind === 'plugin' ? 'plugin_child' : 'standalone', relativeRoot }, requirement: 'optional', toolCap: null });
    const next = { ...configuration, selections: [...other, ...nextEntries], workflow: { version: 1 as const,
      packages: (configuration.workflow?.packages ?? []).map(value => value.resourceRef === pkg.resourceRef
        ? { ...pkg, ...(parent ? {} : { skillSelection: { kind: 'skills' as const, relativeRoots: [...nextRoots] } }) } : value) } };
    const paths = new Set(activeExtensionDeclarations(next, metadata).map(declaration => declaration.declarationPath));
    // Dropping an optional child deliberately removes only its captured declarations; parent requirements remain.
    next.workflow.packages = next.workflow.packages.map(value => value.resourceRef === pkg.resourceRef
      ? { ...value, declarations: value.declarations.filter(declaration => paths.has(declaration.declarationPath)) } : value);
    onChange(next);
  };
  return <details className="group rounded-xl border bg-background" data-testid="agent-extension-package">
    <summary className="flex cursor-pointer list-none items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="agent-extension-package-summary">
      {metadata ? <PluginExtensionAvatar size="sm" name={metadata.displayName} identity={`${key}:${context.workspaceId}`} icon={metadata.icon} />
        : <span aria-hidden="true" data-testid="agent-extension-package-metadata-placeholder"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
          {error ? <CircleAlert className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
        </span>}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{metadata?.displayName ?? copy('Paketdetails', 'Package details')}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{parent ? 'Plugin' : copy('Skill-Auswahl', 'Skill selection')}{metadata ? ` · ${metadata.version} · ${roots.length} ${copy('Skills', 'skills')}` : ''}</span>
        {pending ? <span role="status" className="mt-1 block text-xs text-muted-foreground">{copy('Paketstand wird geprüft …', 'Checking the package version…')}</span>
          : error ? <span role="alert" className="mt-1 block text-xs text-destructive">{copy('Paketdetails konnten nicht geladen werden. Zum erneuten Prüfen öffnen.', 'Package details could not be loaded. Open to check again.')}</span> : null}</span>
      <span className="text-xs text-muted-foreground group-open:hidden">{copy('Anpassen', 'Customize')}</span>
    </summary>
    <div className="space-y-4 border-t p-3">
      {error ? <div className="space-y-2 text-xs text-destructive"><p>{error}</p><Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={() => setRetry(value => value + 1)}>{copy('Erneut prüfen', 'Check again')}</Button></div> : null}
      {metadata ? <><p className="text-xs leading-relaxed text-muted-foreground">{metadata.description}</p>
        <div className="space-y-2"><h5 className="text-xs font-medium">{copy('Bestandteile', 'Components')}</h5>{metadata.children.map(child => <label key={child.relativeRoot} className="flex items-start gap-2.5 rounded-lg bg-muted/30 p-2.5">
          <WorkflowCheckbox checked={roots.includes(child.relativeRoot)} disabled={disabled || child.required || !parent && roots.length === 1 && roots.includes(child.relativeRoot)}
            onCheckedChange={checked => changeRoots(child.relativeRoot, checked)} />
          <PluginExtensionAvatar size="sm" name={child.title || child.name} identity={`${key}:${child.relativeRoot}:${context.workspaceId}`} icon={child.icon} />
          <span className="min-w-0 text-sm"><span className="font-medium">{child.title || child.name}</span>{child.required ? <span className="ml-2 text-xs text-muted-foreground">{copy('Pflichtbestandteil', 'Required')}</span> : null}
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{child.description}</span></span>
        </label>)}</div>
        {activeExtensionDeclarations(configuration, metadata).map(declaration => <div className="space-y-3" key={declaration.declarationPath}>
          {declaration.workflow.integrationCapabilities.map(definition => <AgentExtensionCapabilityEditor key={definition.id} definition={definition} pin={metadata.pin}
            declarationPath={declaration.declarationPath} target={target} context={context} disabled={disabled}
            bindingSummaries={bindingSummaries?.filter(summary => summary.resourceRef === pkg.resourceRef && summary.publishedRevisionRef === pkg.publishedRevisionRef
              && summary.declarationPath === declaration.declarationPath && summary.capabilityId === definition.id)}
            value={pkg.declarations.find(row => row.declarationPath === declaration.declarationPath)?.capabilities.find(row => row.capabilityId === definition.id)}
            onChange={capability => {
              const current = pkg.declarations.find(row => row.declarationPath === declaration.declarationPath);
              const capabilities = [...(current?.capabilities ?? []).filter(row => row.capabilityId !== definition.id), ...(capability ? [capability] : [])];
              changePackage({ ...pkg, declarations: [...pkg.declarations.filter(row => row.declarationPath !== declaration.declarationPath),
                ...(capabilities.length ? [{ declarationPath: declaration.declarationPath, capabilities }] : [])] });
            }} />)}
        </div>)}
        <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-medium">{copy('Paket- und Skillgrenzen', 'Package and skill limits')}</summary>
          <div className="mt-3 space-y-3">{entries.map((entry, index) => <div key={JSON.stringify(entry.selection)} className="space-y-2">
            <p className="text-xs font-medium">{entry.selection.kind === 'skill' ? metadata.children.find(child => child.relativeRoot === ('relativeRoot' in entry.selection ? entry.selection.relativeRoot : undefined))?.title
              ?? metadata.children.find(child => child.relativeRoot === ('relativeRoot' in entry.selection ? entry.selection.relativeRoot : undefined))?.name ?? copy('Skill', 'Skill') : metadata.displayName}</p>
            <label className="flex items-start gap-2 text-xs"><WorkflowCheckbox checked={entry.requirement === 'required'} disabled={disabled}
              onCheckedChange={checked => onChange({ ...configuration, selections: configuration.selections.map(row => row === entry ? { ...entry, requirement: checked ? 'required' : 'optional' } : row) })} />{copy('Für den Agenten erforderlich', 'Required for this agent')}</label>
            <AgentExtensionToolCapEditor value={entry.toolCap} disabled={disabled} onChange={toolCap => onChange({ ...configuration,
              selections: configuration.selections.map(row => row === entries[index] ? { ...row, toolCap } : row) })} />
          </div>)}</div></details>
      </> : null}
      <Button type="button" size="sm" variant="ghost" disabled={disabled} className="text-muted-foreground" onClick={() => onChange({ ...configuration,
        selections: configuration.selections.filter(entry => !(entry.selection.kind === 'plugin' || entry.selection.kind === 'skill') || entry.selection.package.resourceRef !== pkg.resourceRef),
        workflow: { version: 1, packages: (configuration.workflow?.packages ?? []).filter(value => value.resourceRef !== pkg.resourceRef) } })}><Trash2 className="size-3.5" />{copy('Paket aus Agent entfernen', 'Remove package from agent')}</Button>
    </div>
  </details>;
}
