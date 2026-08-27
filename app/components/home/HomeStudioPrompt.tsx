'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { Badge } from '@/components/ui/badge';
import { useStudioPersonas } from '@/app/apps/studio/hooks/useStudioPersonas';
import { useStudioPresets } from '@/app/apps/studio/hooks/useStudioPresets';
import { useStudioProducts } from '@/app/apps/studio/hooks/useStudioProducts';
import { useStudioStyles } from '@/app/apps/studio/hooks/useStudioStyles';
import { StudioPromptComposer, canGenerateWithStudioState } from '@/app/apps/studio/components/create/StudioPromptComposer';
import { buildStudioGeneratePayload } from '@/app/apps/studio/utils/studio-generate-payload';
import {
  createStudioGenerateHandoffDraft,
  createStudioGenerateHandoffId,
  persistStudioGenerateHandoff,
} from '@/app/apps/studio/utils/studio-generate-handoff';
import { createStudioGenerationStore } from '@/app/store/studio-generation-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface HomeStudioPromptProps {
  studioHref: string;
}

export function HomeStudioPrompt({ studioHref }: HomeStudioPromptProps) {
  const [homeStore] = useState(createStudioGenerationStore);
  const store = useStore(homeStore);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();
  const presetsHook = useStudioPresets();
  const { fetchPresets } = presetsHook;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  useEffect(() => {
    void fetchPresets();
  }, [fetchPresets]);

  const canGenerate = canGenerateWithStudioState(store);

  const handleGenerate = useCallback(() => {
    if (submitLockRef.current || !canGenerate) return;
    if (!activeWorkspaceId) {
      setHandoffError('Der aktive Workspace ist noch nicht bereit. Bitte versuche es gleich noch einmal.');
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    setHandoffError(null);

    const id = createStudioGenerateHandoffId();
    const payload = {
      ...buildStudioGeneratePayload(store),
      client_request_id: id,
    };
    const stored = persistStudioGenerateHandoff({
      id,
      payload,
      workspaceId: activeWorkspaceId,
      draft: createStudioGenerateHandoffDraft(store),
    });

    if (!stored) {
      submitLockRef.current = false;
      setIsSubmitting(false);
      setHandoffError('Die Studio-Anfrage konnte nicht sicher übergeben werden. Bitte erlaube Session-Speicher und versuche es erneut.');
      return;
    }

    window.location.assign(`${studioHref}?handoff=${encodeURIComponent(id)}`);
  }, [activeWorkspaceId, canGenerate, store, studioHref]);

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <StudioPromptComposer
        state={store}
        products={productsHook.products}
        personas={personasHook.personas}
        styles={stylesHook.styles}
        presets={presetsHook.presets}
        productsLoading={productsHook.loading}
        personasLoading={personasHook.loading}
        stylesLoading={stylesHook.loading}
        fetchProducts={productsHook.fetchProducts}
        fetchPersonas={personasHook.fetchPersonas}
        fetchStyles={stylesHook.fetchStyles}
        onGenerate={handleGenerate}
        isGenerating={isSubmitting}
        canGenerate={canGenerate}
      />
      {handoffError ? (
        <Badge variant="outline" className="mt-2 rounded-full border-destructive/40 text-destructive">
          {handoffError}
        </Badge>
      ) : null}
    </div>
  );
}
