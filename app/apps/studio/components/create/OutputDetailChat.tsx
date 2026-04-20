'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';

interface OutputDetailChatProps {
  generation: StudioGeneration;
  output: StudioGenerationOutput;
  generations: StudioGeneration[];
  onSelectOutput: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => void;
}

function normalizeMediaUrl(mediaUrl: string): string {
  if (typeof window === 'undefined') {
    return mediaUrl;
  }

  try {
    return new URL(mediaUrl, window.location.origin).toString();
  } catch {
    return mediaUrl;
  }
}

export function OutputDetailChat({ generation, output, generations, onSelectOutput }: OutputDetailChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(output.piSessionId ?? null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    setSessionId(output.piSessionId ?? null);
    setSessionError(null);
  }, [output.id, output.piSessionId]);

  useEffect(() => {
    if (output.piSessionId) {
      setSessionId(output.piSessionId);
      return;
    }

    let isCancelled = false;

    const ensureStudioSession = async () => {
      setIsLoadingSession(true);
      setSessionError(null);

      try {
        const response = await fetch(`/api/studio/generations/${generation.id}/outputs/${output.id}/session`, {
          method: 'POST',
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok || !payload?.success || typeof payload?.sessionId !== 'string') {
          throw new Error(payload?.error || `Failed to create chat session (${response.status})`);
        }

        if (!isCancelled) {
          setSessionId(payload.sessionId);
        }
      } catch (error) {
        if (!isCancelled) {
          setSessionError(error instanceof Error ? error.message : 'Failed to create studio chat session.');
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingSession(false);
        }
      }
    };

    void ensureStudioSession();

    return () => {
      isCancelled = true;
    };
  }, [generation.id, output.id, output.piSessionId]);

  const requestContext = useMemo(() => ({
    currentPage: '/studio/create',
    studioContext: {
      generationId: generation.id,
      currentOutputId: output.id,
      generationPrompt: generation.prompt || generation.rawPrompt || null,
      generationPresetId: generation.studioPresetId,
      generationProductIds: generation.product_ids ?? [],
      generationPersonaIds: generation.persona_ids ?? [],
      outputFilePath: output.filePath,
      outputMediaUrl: output.mediaUrl,
    },
  }), [generation.id, generation.persona_ids, generation.product_ids, generation.prompt, generation.rawPrompt, generation.studioPresetId, output.filePath, output.id, output.mediaUrl]);

  const handleMediaClick = (mediaUrl: string) => {
    const targetUrl = normalizeMediaUrl(mediaUrl);

    for (const candidateGeneration of generations) {
      const candidateOutput = candidateGeneration.outputs.find((item) => {
        if (!item.mediaUrl) return false;
        return normalizeMediaUrl(item.mediaUrl) === targetUrl;
      });

      if (candidateOutput) {
        onSelectOutput({ generation: candidateGeneration, output: candidateOutput });
        return;
      }
    }
  };

  if (isLoadingSession && !sessionId) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="rounded-3xl border border-border/70 bg-background/85 px-5 py-4 text-sm text-muted-foreground shadow-sm">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Studio-Chat wird vorbereitet...
          </span>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm rounded-3xl border border-red-500/30 bg-red-500/5 px-5 py-4 text-sm text-red-700 shadow-sm dark:text-red-300">
          {sessionError}
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return null;
  }

  return (
    <div className="h-full min-h-0">
      <CanvasAgentChat
        hideNavHeader
        forcedSessionId={sessionId}
        requestContext={requestContext}
        onMediaClick={handleMediaClick}
        isSurfaceVisible
      />
    </div>
  );
}
