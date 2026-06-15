'use client';

import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ComposerReferencePickerItem } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import type { FilePickerFile, ReferencePickerValue, SkillPickerSkill } from '@/app/components/canvas-agent-chat/ChatComposer';
import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { renderSkillIcon } from '@/app/lib/skills/skill-icons';
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
  const [isLoadingReferenceItems, setIsLoadingReferenceItems] = useState(false);
  const referencePickerRef = useRef<HTMLDivElement>(null);
  const referenceRequestIdRef = useRef(0);

  const closeReferencePicker = useCallback(() => {
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setSelectedReferenceIndex(0);
    setAvailableSkills(null);
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
          label: file.path,
          payload: file,
        }));
        setReferencePickerItems(items);
        setSelectedReferenceIndex(0);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    }
  }, []);

  const setSkillReferenceItems = useCallback((skills: SkillPickerSkill[], query: string) => {
    const items = searchSkillReferenceEntries(skills, query).map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      icon: renderSkillIcon(skill.name, skill.description),
      label: skill.title,
      secondaryLabel: `/${skill.name}`,
      payload: skill,
    }));
    setReferencePickerItems(items);
    setSelectedReferenceIndex(0);
  }, []);

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
        name: skill.name,
        title: skill.title,
      }));
      setAvailableSkills(nextSkills);
      return nextSkills;
    } catch (err) {
      console.error('Failed to fetch skills', err);
      return [];
    }
  }, [availableSkills]);

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

    void fetchSkills().then((skills) => {
      if (referenceRequestIdRef.current !== requestId) {
        return;
      }

      setSkillReferenceItems(skills, match.query);
      setIsLoadingReferenceItems(false);
    });
  }, [closeReferencePicker, fetchFiles, fetchSkills, resetInputHistoryNavigation, setInput, setSkillReferenceItems]);

  const handleReferenceSelect = useCallback((item: ComposerReferencePickerItem<ReferencePickerValue>) => {
    if (!activeReferenceMatch) {
      return;
    }

    const replacement = item.kind === 'file'
      ? `@"${(item.payload as FilePickerFile).path}" `
      : `/${(item.payload as SkillPickerSkill).name} `;
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
