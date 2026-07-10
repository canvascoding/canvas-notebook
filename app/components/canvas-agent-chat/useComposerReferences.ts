'use client';

import {
  useCallback,
  createElement,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ComposerReferencePickerItem } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import type { FilePickerFile, PluginPickerPlugin, ReferencePickerValue, SkillPickerSkill } from '@/app/components/canvas-agent-chat/ChatComposer';
import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import { filterSkillsForAgent } from '@/app/lib/chat/reference-capabilities';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { listWorkspaceFileReferences } from '@/app/lib/files/client';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { searchSkillReferenceEntries } from '@/app/lib/skills/skill-reference-search';

type UseComposerReferencesParams = {
  agentId: string;
  input: string;
  relevantSkillNames?: string[] | null;
  workspaceId: string | null;
  resetInputHistoryNavigation: () => void;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function useComposerReferences({
  agentId,
  input,
  relevantSkillNames,
  workspaceId,
  resetInputHistoryNavigation,
  setInput,
  textareaRef,
}: UseComposerReferencesParams) {
  const [activeReferenceMatch, setActiveReferenceMatch] = useState<ComposerReferenceMatch | null>(null);
  const [referencePickerItems, setReferencePickerItems] = useState<ComposerReferencePickerItem<ReferencePickerValue>[]>([]);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<SkillPickerSkill[] | null>(null);
  const [availablePlugins, setAvailablePlugins] = useState<PluginPickerPlugin[] | null>(null);
  const [isLoadingReferenceItems, setIsLoadingReferenceItems] = useState(false);
  const referenceRequestIdRef = useRef(0);

  const closeReferencePicker = useCallback(() => {
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    setAvailableSkills(null);
    setAvailablePlugins(null);
    referenceRequestIdRef.current += 1;
  }, []);

  const fetchFiles = useCallback(async (query: string = ''): Promise<ComposerReferencePickerItem<ReferencePickerValue>[]> => {
    if (!workspaceId) {
      throw new Error('Workspace context is not ready');
    }
    const files = await listWorkspaceFileReferences({ query, limit: 50, workspaceId });
    return files.map((file) => ({
      id: `file:${file.path}`,
      kind: 'file' as const,
      icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }),
      label: getFileDisplayPath(file.path),
      secondaryLabel: 'File',
      payload: file as FilePickerFile,
    }));
  }, [workspaceId]);

  const buildCapabilityReferenceItems = useCallback((plugins: PluginPickerPlugin[], skills: SkillPickerSkill[], query: string) => {
    const effectiveSkills = filterSkillsForAgent(skills, {
      agentId,
      defaultAgentId: DEFAULT_AGENT_ID,
      relevantSkillNames,
    });
    const skillNames = new Set(effectiveSkills.map((skill) => skill.name));
    const pluginItems = searchSkillReferenceEntries(
      plugins.map((plugin) => ({
        ...plugin,
        title: plugin.interface?.displayName || plugin.name,
        description: plugin.interface?.shortDescription || plugin.description,
      })),
      query,
    ).filter((plugin) => !skillNames.has(plugin.name)).map((plugin) => ({
      id: `plugin:${plugin.name}`,
      kind: 'plugin' as const,
      icon: createElement(CanvasPluginIcon, { plugin, className: 'h-5 w-5 text-[10px]' }),
      label: plugin.interface?.displayName || plugin.name,
      secondaryLabel: `/${plugin.name} · Plugin`,
      payload: plugin,
    }));

    const pluginNames = new Set(plugins.map((plugin) => plugin.name));
    const skillItems = searchSkillReferenceEntries(effectiveSkills, query).map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      icon: createElement(CanvasSkillIcon, { skill, className: 'h-5 w-5 text-[10px]' }),
      label: skill.title,
      secondaryLabel: `/${skill.name} · ${pluginNames.has(skill.name) ? 'Skill + Plugin' : 'Skill'}`,
      payload: skill,
    }));

    return [...pluginItems, ...skillItems];
  }, [agentId, relevantSkillNames]);

  const fetchPlugins = useCallback(async () => {
    if (availablePlugins) {
      return availablePlugins;
    }

    try {
      const res = await fetch('/api/plugins');
      const data = await safeFetchJson<{ success: boolean; plugins?: PluginPickerPlugin[] }>(res);
      if (!data?.success) {
        return [];
      }

      const nextPlugins = (data.plugins || [])
        .filter((plugin) => plugin.enabled !== false)
        .map((plugin) => ({
          description: plugin.description,
          enabled: plugin.enabled,
          interface: plugin.interface,
          name: plugin.name,
          skills: plugin.skills,
          version: plugin.version,
        }));
      setAvailablePlugins(nextPlugins);
      return nextPlugins;
    } catch (err) {
      console.error('Failed to fetch plugins', err);
      return [];
    }
  }, [availablePlugins]);

  const fetchSkills = useCallback(async () => {
    if (availableSkills) {
      return availableSkills;
    }

    try {
      const res = await fetch('/api/skills');
      const data = await safeFetchJson<{ success: boolean; skills?: Array<SkillPickerSkill & { path?: string }> }>(res);
      if (!data?.success) {
        return [];
      }

      const nextSkills = (data.skills || []).filter((skill) => skill.enabled).map((skill) => ({
          description: skill.description,
          enabled: skill.enabled,
          core: skill.core,
          interface: skill.interface,
          name: skill.name,
          plugin: skill.plugin,
          title: skill.title,
      }));
      setAvailableSkills(nextSkills);
      return nextSkills;
    } catch (err) {
      console.error('Failed to fetch skills', err);
      return [];
    }
  }, [availableSkills]);

  const fetchCapabilities = useCallback(async () => {
    const [plugins, skills] = await Promise.all([fetchPlugins(), fetchSkills()]);
    return { plugins, skills };
  }, [fetchPlugins, fetchSkills]);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    resetInputHistoryNavigation();
    setInput(value);

    const match = findActiveComposerReference(value, cursorPos);
    if (!match) {
      setIsLoadingReferenceItems(false);
      closeReferencePicker();
      return;
    }

    setActiveReferenceMatch(match);
    setIsLoadingReferenceItems(true);
    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;

    if (match.kind === 'file') {
      void fetchFiles(match.query).then((items) => {
        if (referenceRequestIdRef.current !== requestId) return;
        setReferencePickerItems(items);
        setSelectedReferenceIndex(0);
      }).catch((err) => {
        console.error('Failed to fetch files', err);
      }).finally(() => {
        if (referenceRequestIdRef.current === requestId) {
          setIsLoadingReferenceItems(false);
        }
      });
      return;
    }

    if (match.kind === 'all') {
      void Promise.all([fetchFiles(match.query), fetchCapabilities()]).then(([fileItems, { plugins, skills }]) => {
        if (referenceRequestIdRef.current !== requestId) return;
        setReferencePickerItems([...fileItems, ...buildCapabilityReferenceItems(plugins, skills, match.query)]);
        setSelectedReferenceIndex(0);
      }).catch((err) => {
        console.error('Failed to fetch references', err);
      }).finally(() => {
        if (referenceRequestIdRef.current === requestId) setIsLoadingReferenceItems(false);
      });
      return;
    }

    void fetchCapabilities().then(({ plugins, skills }) => {
      if (referenceRequestIdRef.current !== requestId) {
        return;
      }

      setReferencePickerItems(buildCapabilityReferenceItems(plugins, skills, match.query));
      setSelectedReferenceIndex(0);
      setIsLoadingReferenceItems(false);
    });
  }, [buildCapabilityReferenceItems, closeReferencePicker, fetchCapabilities, fetchFiles, resetInputHistoryNavigation, setInput]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ReferencePickerValue>) => {
    if (!activeReferenceMatch) {
      return;
    }

    const replacement = item.kind === 'file'
      ? `@"${(item.payload as FilePickerFile).path}" `
      : `/${(item.payload as PluginPickerPlugin | SkillPickerSkill).name} `;
    const { nextValue, nextCursorPosition } = replaceComposerReference(input, activeReferenceMatch, replacement);

    resetInputHistoryNavigation();
    setInput(nextValue);
    closeReferencePicker();

    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    }, 0);
  }, [activeReferenceMatch, closeReferencePicker, input, resetInputHistoryNavigation, setInput, textareaRef]);

  const selectNextReference = useCallback(() => {
    setSelectedReferenceIndex((prev) => (prev < referencePickerItems.length - 1 ? prev + 1 : prev));
  }, [referencePickerItems.length]);

  const selectPreviousReference = useCallback(() => {
    setSelectedReferenceIndex((prev) => (prev > 0 ? prev - 1 : 0));
  }, []);

  return {
    activeReferenceMatch,
    closeReferencePicker,
    handleInputChange,
    handleReferenceSelect,
    isLoadingReferenceItems,
    referencePickerItems,
    selectedReferenceIndex,
    selectNextReference,
    selectPreviousReference,
  };
}
