import 'server-only';
import { assertChatBodySelection, deriveChatBodySelection } from './chat-body-contracts';
import { chatCorePluginSelectionEligibility, chatPackageSelectionEligibility, intersectChatCaps } from './extension-options-eligibility';
import { readAgentExtensionPackageVersion } from '@/app/lib/agents/extension-package-options';
import { revalidateChatExtensionOptionsContext, type ChatExtensionOptionsContext } from './extension-options-context';
import type { ChatExtensionOptionsPreview, ChatExtensionOptionsRequest } from './extension-options-contracts';
import { validateChatConnectionMetadata } from './extension-options-validation';
import { extensionSelectionIdentity } from '@/app/lib/capabilities/extensions/contracts';

type Request = Extract<ChatExtensionOptionsRequest, { operation: 'preview' }>;
/** Real metadata checks without inventing a Session, runtime proof, or a claim about the final cumulative prompt. */
export async function previewChatExtensionSelection(context: ChatExtensionOptionsContext, request: Request,
  signal: AbortSignal): Promise<ChatExtensionOptionsPreview> {
  const selection = deriveChatBodySelection(request.body);
  const publicIntake = request.intakeSelection ? { version: 1 as const, origin: 'turn_reference' as const,
    selections: request.intakeSelection.selections.map(({ accountSelectionRef: _receipt, ...entry }) => entry),
    ...(request.intakeSelection.packageConnections ? { packageConnections: request.intakeSelection.packageConnections } : {}) } : null;
  assertChatBodySelection(request.body, publicIntake);
  const issues: ChatExtensionOptionsPreview['issues'] = [], requirements: ChatExtensionOptionsPreview['requirements'] = [],
    effectiveToolCaps: ChatExtensionOptionsPreview['effectiveToolCaps'] = [];
  const error = (code: string, message: string, path?: string) => issues.push({ code, message, severity: 'error', ...(path ? { path } : {}) });
  for (const entry of selection?.selections ?? []) {
    signal.throwIfAborted();
    const current = entry.selection, path = extensionSelectionIdentity(current);
    try {
      if(current.kind==='core_plugin') {
        const eligibility=await chatCorePluginSelectionEligibility(context,current);
        if(eligibility.action!=='select')throw new Error(eligibility.reason?.message);
        if(entry.toolCap!==null)throw new Error('Core instruction selections require a null tool capability field.');
        effectiveToolCaps.push({selection:current,toolCap:entry.toolCap});
      } else if (current.kind === 'plugin' || current.kind === 'skill') {
        const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, current.package, { allowPersonalPackages: true });
        const eligibility = await chatPackageSelectionEligibility(context, current, source);
        if (eligibility.action !== 'select') throw new Error(eligibility.reason?.message);
        effectiveToolCaps.push({ selection: current, toolCap: entry.toolCap });
        const roots = current.kind === 'skill' ? [current.relativeRoot] : current.skillSelection.kind === 'all'
          ? source.metadata.skillRoots.map(root => root.relativeRoot) : current.skillSelection.relativeRoots;
        for (const declaration of source.metadata.declarations) {
          if (declaration.declarationPath !== '.canvas-plugin/plugin.json' && !roots.some(root => declaration.declarationPath === (root ? `${root}/agents/canvas.yaml` : 'agents/canvas.yaml'))) continue;
          for (const capability of declaration.workflow.integrationCapabilities) {
            const mapping = selection?.packageConnections?.find(mapping => JSON.stringify(mapping.package) === JSON.stringify(current.package)
              && mapping.declarationPath === declaration.declarationPath && mapping.capabilityId === capability.id);
            let state: ChatExtensionOptionsPreview['requirements'][number]['state'] = 'unbound';
            if (mapping) {
              const mapped = request.intakeSelection?.selections.find(entry => JSON.stringify(entry.selection) === JSON.stringify(mapping.connectionSelection));
              if (!mapped) throw new Error('The mapped exact connection is absent from the intake envelope.');
              try { await validateChatConnectionMetadata(context, mapped, signal, mapping); state = 'bound'; }
              catch (cause) { state = 'unavailable'; error('CHAT_EXTENSION_MAPPING_UNAVAILABLE', cause instanceof Error ? cause.message : 'The exact requirement source is unavailable.', path); }
            } else if (capability.required) error('CHAT_EXTENSION_REQUIREMENT_MISSING', `Choose a source for ${capability.id}.`, path);
            requirements.push({ package: current.package, declarationPath: declaration.declarationPath, capabilityId: capability.id,
              required: capability.required, state, ...(mapping ? { alternativeKey: mapping.alternativeKey, connectionSelection: mapping.connectionSelection } : {}) });
          }
        }
      } else {
        const mapped = selection?.packageConnections?.filter(mapping => JSON.stringify(mapping.connectionSelection) === JSON.stringify(current)) ?? [];
        const intake = request.intakeSelection?.selections.find(input => JSON.stringify(input.selection) === JSON.stringify(current));
        if (!intake) throw new Error('The exact intake selection is missing.');
        const caps = mapped.length ? await Promise.all(mapped.map(mapping => validateChatConnectionMetadata(context, intake, signal, mapping)))
          : [await validateChatConnectionMetadata(context, intake, signal)];
        effectiveToolCaps.push({ selection: current, toolCap: intersectChatCaps(entry.toolCap, ...caps.map(cap => cap.toolCap)) });
      }
    } catch (cause) { error('CHAT_EXTENSION_UNAVAILABLE', cause instanceof Error ? cause.message : 'This exact extension is unavailable.', path); }
  }
  await revalidateChatExtensionOptionsContext(context);
  return { configurationReadiness: issues.some(issue => issue.severity === 'error') ? 'blocked' : 'unknown', contextValidation: 'unknown',
    personalSetupRequired: false, runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSendValidationRequired: true,
    issues, requirements, effectiveToolCaps, toolConflicts: [], budget: null };
}
