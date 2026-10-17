import type { ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import { publicPluginExtensionIcon, type PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';

/** Public metadata only. Actual bytes and exact child/source authority are checked by the image route. */
export function agentExtensionPackageIcon(pin: ExtensionPackagePin, declarations: readonly unknown[],
  workspaceId?: string | null, childRelativeRoot?: string): PluginExtensionIcon | undefined {
  const sourceKey = JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum, workspaceId ?? null, childRelativeRoot ?? null]);
  for (const declaration of declarations) {
    const publicIcon = publicPluginExtensionIcon(declaration, sourceKey);
    if (publicIcon) return publicIcon;
    if (typeof declaration !== 'string' || !declaration || declaration.length > 1024
      || /[\p{Cc}\p{Cf}\\]/u.test(declaration)) continue;
    const relative = declaration.startsWith('./') ? declaration.slice(2) : declaration;
    if (relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !/\.(?:png|jpe?g|gif|webp|svg)$/iu.test(relative)) continue;
    const query = new URLSearchParams({ resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef, checksum: pin.checksum });
    if (workspaceId) query.set('workspaceId', workspaceId);
    if (childRelativeRoot !== undefined) query.set('childRelativeRoot', childRelativeRoot);
    return { url: `/api/agents/extension-options/icon?${query}`, sourceKey };
  }
  return undefined;
}
