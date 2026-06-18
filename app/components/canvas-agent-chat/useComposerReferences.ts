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
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { searchSkillReferenceEntries } from '@/app/lib/skills/skill-reference-search';

type UseComposerReferencesParams = {
  input: string;
  resetInputHistoryNavigation: () => void;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function useComposerReferences({
  input,
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
  const referencePickerRef = useRef<HTMLDivElement>(null);
  const referenceRequestIdRef = useRef(0);

  const closeReferencePicker = useCallback(() => {
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    setAvailableSkills(null);
    setAvailablePlugins(null);
    referenceRequestIdRef.current += 1;
  }, []);

  const fetchFiles = useCallback(async (query: string = '', requestId: number) => {
    try {
      const res = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=50`);
      const data = await safeFetchJson<{ success: boolean; files?: FilePickerFile[] }>(res);
      if (requestId !== referenceRequestIdRef.current) {
        return;
      }

      if (data?.success) {
        const items = (data.files as FilePickerFile[]).map((file) => ({
          id: `file:${file.path}`,
          kind: 'file' as const,
          icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }),
          label: getFileDisplayPath(file.path),
          payload: file,
        }));
        setReferencePickerItems(items);
        setSelectedReferenceIndex(0);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    }
  }, []);

  const setCapabilityReferenceItems = useCallback((plugins: PluginPickerPlugin[], skills: SkillPickerSkill[], query: string) => {
    const pluginItems = searchSkillReferenceEntries(
      plugins.map((plugin) => ({
        ...plugin,
        title: plugin.interface?.displayName || plugin.name,
        description: plugin.interface?.shortDescription || plugin.description,
      })),
      query,
    ).map((plugin) => ({
      id: `plugin:${plugin.name}`,
      kind: 'plugin' as const,
      icon: createElement(CanvasPluginIcon, { plugin, className: 'h-5 w-5 text-[10px]' }),
      label: plugin.interface?.displayName || plugin.name,
      secondaryLabel: `/${plugin.name} · Plugin`,
      payload: plugin,
    }));

    const skillItems = searchSkillReferenceEntries(skills, query).map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      icon: createElement(CanvasSkillIcon, { skill, className: 'h-5 w-5 text-[10px]' }),
      label: skill.title,
      secondaryLabel: `/${skill.name} · Skill`,
      payload: skill,
    }));

    setReferencePickerItems([...pluginItems, ...skillItems]);
    setSelectedReferenceIndex(0);
  }, []);

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
      void fetchFiles(match.query, requestId).finally(() => {
        if (referenceRequestIdRef.current === requestId) {
          setIsLoadingReferenceItems(false);
        }
      });
      return;
    }

    void fetchCapabilities().then(({ plugins, skills }) => {
      if (referenceRequestIdRef.current !== requestId) {
        return;
      }

      setCapabilityReferenceItems(plugins, skills, match.query);
      setIsLoadingReferenceItems(false);
    });
  }, [closeReferencePicker, fetchCapabilities, fetchFiles, resetInputHistoryNavigation, setCapabilityReferenceItems, setInput]);

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
    referencePickerRef,
    selectedReferenceIndex,
    selectNextReference,
    selectPreviousReference,
  };
}
