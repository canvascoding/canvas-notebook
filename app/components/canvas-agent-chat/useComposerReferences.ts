'use client';

import {
  useCallback,
  createElement,
  useEffect,
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

const REFERENCE_SEARCH_DEBOUNCE_MS = 120;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Failed to load references';
}

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
  const [referencePickerError, setReferencePickerError] = useState<string | null>(null);
  const referenceRequestIdRef = useRef(0);
  const referenceAbortControllerRef = useRef<AbortController | null>(null);
  const referenceDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeReferencePicker = useCallback(() => {
    if (referenceDebounceTimerRef.current) {
      clearTimeout(referenceDebounceTimerRef.current);
      referenceDebounceTimerRef.current = null;
    }
    referenceAbortControllerRef.current?.abort();
    referenceAbortControllerRef.current = null;
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    setReferencePickerError(null);
    setIsLoadingReferenceItems(false);
    referenceRequestIdRef.current += 1;
  }, []);

  useEffect(() => () => {
    if (referenceDebounceTimerRef.current) clearTimeout(referenceDebounceTimerRef.current);
    referenceAbortControllerRef.current?.abort();
  }, []);

  const fetchFiles = useCallback(async (
    query: string = '',
    signal?: AbortSignal,
  ): Promise<ComposerReferencePickerItem<ReferencePickerValue>[]> => {
    if (!workspaceId) {
      throw new Error('Workspace context is not ready');
    }
    const files = await listWorkspaceFileReferences({ query, limit: 50, workspaceId, signal });
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

  const fetchPlugins = useCallback(async (signal?: AbortSignal) => {
    if (availablePlugins) {
      return availablePlugins;
    }

    const res = await fetch('/api/plugins', { cache: 'no-store', credentials: 'include', signal });
    const data = await safeFetchJson<{ success: boolean; plugins?: PluginPickerPlugin[]; error?: string }>(res);
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to load plugins');
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
  }, [availablePlugins]);

  const fetchSkills = useCallback(async (signal?: AbortSignal) => {
    if (availableSkills) {
      return availableSkills;
    }

    const res = await fetch('/api/skills', { cache: 'no-store', credentials: 'include', signal });
    const data = await safeFetchJson<{ success: boolean; skills?: Array<SkillPickerSkill & { path?: string }>; error?: string }>(res);
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to load skills');
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
  }, [availableSkills]);

  const fetchCapabilities = useCallback(async (signal?: AbortSignal) => {
    const [pluginResult, skillResult] = await Promise.allSettled([
      fetchPlugins(signal),
      fetchSkills(signal),
    ]);
    if (pluginResult.status === 'rejected' && skillResult.status === 'rejected') {
      throw pluginResult.reason;
    }
    return {
      plugins: pluginResult.status === 'fulfilled' ? pluginResult.value : [],
      skills: skillResult.status === 'fulfilled' ? skillResult.value : [],
      partialError: pluginResult.status === 'rejected'
        ? errorMessage(pluginResult.reason)
        : skillResult.status === 'rejected'
          ? errorMessage(skillResult.reason)
          : null,
    };
  }, [fetchPlugins, fetchSkills]);

  const loadReferenceItems = useCallback(async (
    match: ComposerReferenceMatch,
    requestId: number,
    signal: AbortSignal,
  ) => {
    try {
      let items: ComposerReferencePickerItem<ReferencePickerValue>[] = [];
      let partialError: string | null = null;

      if (match.kind === 'file') {
        items = await fetchFiles(match.query, signal);
      } else if (match.kind === 'capability') {
        const capabilities = await fetchCapabilities(signal);
        items = buildCapabilityReferenceItems(capabilities.plugins, capabilities.skills, match.query);
        partialError = capabilities.partialError;
      } else {
        const [fileResult, capabilityResult] = await Promise.allSettled([
          fetchFiles(match.query, signal),
          fetchCapabilities(signal),
        ]);
        if (fileResult.status === 'rejected' && capabilityResult.status === 'rejected') {
          throw fileResult.reason;
        }
        const fileItems = fileResult.status === 'fulfilled' ? fileResult.value : [];
        const capabilityItems = capabilityResult.status === 'fulfilled'
          ? buildCapabilityReferenceItems(
            capabilityResult.value.plugins,
            capabilityResult.value.skills,
            match.query,
          )
          : [];
        items = [...fileItems, ...capabilityItems];
        partialError = fileResult.status === 'rejected'
          ? errorMessage(fileResult.reason)
          : capabilityResult.status === 'rejected'
            ? errorMessage(capabilityResult.reason)
            : capabilityResult.value.partialError;
      }

      if (signal.aborted || referenceRequestIdRef.current !== requestId) return;
      setReferencePickerItems(items);
      setSelectedReferenceIndex(0);
      setReferencePickerError(items.length === 0 ? partialError : null);
    } catch (error) {
      if (signal.aborted || referenceRequestIdRef.current !== requestId || isAbortError(error)) return;
      setReferencePickerItems([]);
      setSelectedReferenceIndex(0);
      setReferencePickerError(errorMessage(error));
    } finally {
      if (!signal.aborted && referenceRequestIdRef.current === requestId) {
        setIsLoadingReferenceItems(false);
      }
    }
  }, [buildCapabilityReferenceItems, fetchCapabilities, fetchFiles]);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    resetInputHistoryNavigation();
    setInput(value);

    const match = findActiveComposerReference(value, cursorPos);
    if (!match) {
      closeReferencePicker();
      return;
    }

    if (referenceDebounceTimerRef.current) clearTimeout(referenceDebounceTimerRef.current);
    referenceAbortControllerRef.current?.abort();
    const controller = new AbortController();
    referenceAbortControllerRef.current = controller;
    setActiveReferenceMatch(match);
    setIsLoadingReferenceItems(true);
    setReferencePickerError(null);
    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;
    referenceDebounceTimerRef.current = setTimeout(() => {
      referenceDebounceTimerRef.current = null;
      void loadReferenceItems(match, requestId, controller.signal);
    }, match.query ? REFERENCE_SEARCH_DEBOUNCE_MS : 0);
  }, [closeReferencePicker, loadReferenceItems, resetInputHistoryNavigation, setInput]);

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
    referencePickerError,
    referencePickerItems,
    selectedReferenceIndex,
    selectNextReference,
    selectPreviousReference,
  };
}
