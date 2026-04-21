'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import type { StudioGenerationMode, StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { SaveToWorkspaceDialog } from './SaveToWorkspaceDialog';
import { OutputDetailView } from './OutputDetailView';
import { OutputGrid } from './OutputGrid';
import { Badge } from '@/components/ui/badge';
import { PromptBar } from './PromptBar';
import { ControlBar } from './ControlBar';
import { FrameUpload } from './FrameUpload';
import { getDefaultModelForProvider, getAspectRatiosForProvider } from '@/app/lib/integrations/image-generation-constants';

const STARTING_POINTS = [
  {
    title: 'Hero product launch',
    description: 'Clean catalog-style product visual with sharp lighting and premium detail.',
  },
  {
    title: 'Lifestyle campaign moment',
    description: 'Warm editorial scene with people, context, and brand atmosphere.',
  },
  {
    title: 'Beauty close-up',
    description: 'Skincare or cosmetics concept with luminous surfaces and elegant gradients.',
  },
  {
    title: 'Short video concept',
    description: 'Start from a still or text prompt and evolve it into a cinematic clip.',
  },
] as const;

function EmptyState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <div className="max-w-2xl space-y-3">
          <Badge variant="secondary" className="w-fit rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
            Starting Points
          </Badge>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Start with a visual direction, then build from products, personas, and presets.
          </h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            Your outputs will appear here in reverse chronological order. Use the prompt bar below to create images
            or videos, then refine the result with studio presets and references.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STARTING_POINTS.map((item) => (
            <div
              key={item.title}
              className="group rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
            >
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </div>
              <h3 className="mb-2 text-base font-semibold text-foreground">{item.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CreateView() {
  const searchParams = useSearchParams();
  const generationHook = useStudioGeneration();
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const presetsHook = useStudioPresets();
  const { fetchGenerations, generations } = generationHook;
  const { fetchProducts, products } = productsHook;
  const { fetchPersonas, personas } = personasHook;
  const { fetchPresets, presets } = presetsHook;
  const [mode, setMode] = useState<StudioGenerationMode>('image');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [count, setCount] = useState(1);
  const [provider, setProvider] = useState('gemini');
  const [model, setModel] = useState('gemini-3.1-flash-image-preview');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high' | 'auto'>('auto');
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [background, setBackground] = useState<'transparent' | 'opaque' | 'auto'>('auto');
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const initialPrompt = useMemo(() => searchParams.get('prompt') ?? '', [searchParams]);
  const [rawPrompt, setRawPrompt] = useState(initialPrompt);
  const [productRefs, setProductRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [personaRefs, setPersonaRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [presetRef, setPresetRef] = useState<StudioPreset | null>(null);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [extraReferenceUrls, setExtraReferenceUrls] = useState<string[]>([]);
  const [startFrame, setStartFrame] = useState<File | null>(null);
  const [endFrame, setEndFrame] = useState<File | null>(null);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  const resolvedSelectedGeneration = selectedGenerationId
    ? generations.find((g) => g.id === selectedGenerationId) ?? null
    : null;
  const resolvedSelectedOutput = resolvedSelectedGeneration && selectedOutputId
    ? resolvedSelectedGeneration.outputs.find((o) => o.id === selectedOutputId) ?? null
    : null;

  const handleToggleOutputSelect = (outputId: string, selected: boolean) => {
    if (selected) {
      setSelectedOutputIds((prev) => [...prev, outputId]);
    } else {
      setSelectedOutputIds((prev) => prev.filter((id) => id !== outputId));
    }
  };

  const handleSaveToWorkspace = () => {
    if (selectedOutputIds.length === 0) return;
    setShowSaveDialog(true);
  };

  const handleSaveSingleToWorkspace = (_g: StudioGeneration, output: StudioGenerationOutput) => {
    setSelectedOutputIds([output.id]);
    setShowSaveDialog(true);
  };

  useEffect(() => {
    void fetchGenerations();
    void fetchProducts();
    void fetchPersonas();
    void fetchPresets();
  }, [fetchGenerations, fetchProducts, fetchPersonas, fetchPresets]);

  const canGenerate = useMemo(() => {
    return rawPrompt.trim().length > 0 || productRefs.length > 0 || personaRefs.length > 0 || presetRef !== null;
  }, [personaRefs.length, presetRef, productRefs.length, rawPrompt]);

  const handleGenerate = async () => {
    const prompt = negativePrompt.trim()
      ? `${rawPrompt.trim()}\n\nAvoid: ${negativePrompt.trim()}`
      : rawPrompt.trim();

    const result = await generationHook.generate({
      prompt,
      mode,
      product_ids: productRefs.map((product) => product.id),
      persona_ids: personaRefs.map((persona) => persona.id),
      preset_id: presetRef?.id,
      aspect_ratio: aspectRatio,
      count: mode === 'video' ? 1 : count,
      provider,
      model,
      quality: provider === 'openai' ? quality : undefined,
      output_format: provider === 'openai' ? outputFormat : undefined,
      background: provider === 'openai' ? background : undefined,
      extra_reference_urls: extraReferenceUrls,
    });

    if (result) {
      setRawPrompt('');
      setNegativePrompt('');
      setExtraReferenceUrls([]);
      setStartFrame(null);
      setEndFrame(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]">
            {selectedOutputIds.length > 0 && (
              <div className="sticky top-0 z-30 flex items-center justify-between border-b border-border/70 bg-background/90 px-4 py-2 backdrop-blur">
                <div className="text-sm font-medium">
                  {selectedOutputIds.length} ausgewählt
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent"
                    onClick={() => setSelectedOutputIds([])}
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
                    onClick={handleSaveToWorkspace}
                  >
                    In Workspace speichern
                  </button>
                </div>
              </div>
            )}
            <OutputGrid
              generations={generations}
              emptyState={<EmptyState />}
              selectedOutputIds={selectedOutputIds}
              onToggleSelectOutput={handleToggleOutputSelect}
              onOutputOpen={({ generation, output }) => {
                setSelectedGenerationId(generation.id);
                setSelectedOutputId(output.id);
              }}
              onToggleFavorite={(generation, output) => {
                void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
              }}
              onCreateVariation={(generation, output) => {
                setMode('image');
                setRawPrompt(generation.rawPrompt || generation.prompt || '');
                setProductRefs((generation.product_ids ?? []).map((id) => {
                  const p = products.find((product) => product.id === id);
                  return { id, name: p?.name || id };
                }));
                setPersonaRefs((generation.persona_ids ?? []).map((id) => {
                  const p = personas.find((persona) => persona.id === id);
                  return { id, name: p?.name || id };
                }));
                setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
                setAspectRatio(generation.aspectRatio || '1:1');
                setProvider(generation.provider || 'gemini');
                setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
                if (output.mediaUrl) {
                  setExtraReferenceUrls((prev) => (prev.includes(output.mediaUrl!) ? prev : [...prev, output.mediaUrl!]));
                }
                setSelectedGenerationId(null);
                setSelectedOutputId(null);
              }}
              onCreateVideo={(generation, output) => {
                setMode('video');
                setRawPrompt(generation.rawPrompt || generation.prompt || '');
                setProductRefs((generation.product_ids ?? []).map((id) => {
                  const p = products.find((product) => product.id === id);
                  return { id, name: p?.name || id };
                }));
                setPersonaRefs((generation.persona_ids ?? []).map((id) => {
                  const p = personas.find((persona) => persona.id === id);
                  return { id, name: p?.name || id };
                }));
                setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
                setAspectRatio(generation.aspectRatio || '1:1');
                setProvider(generation.provider || 'gemini');
                setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
                if (output.mediaUrl) {
                  setExtraReferenceUrls((prev) => (prev.includes(output.mediaUrl!) ? prev : [...prev, output.mediaUrl!]));
                }
                setSelectedGenerationId(null);
                setSelectedOutputId(null);
              }}
              onDelete={(generation) => {
                void generationHook.deleteGeneration(generation.id);
              }}
              onSaveToWorkspace={handleSaveSingleToWorkspace}
            />
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border/80 bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          {mode === 'video' ? (
            <FrameUpload
              startFrame={startFrame}
              endFrame={endFrame}
              onStartFrameChange={setStartFrame}
              onEndFrameChange={setEndFrame}
            />
          ) : null}

          <PromptBar
            value={{
              rawPrompt,
              productRefs,
              personaRefs,
              presetRef,
              negativePrompt,
              extraReferenceUrls,
            }}
            products={products}
            personas={personas}
            presets={presets}
            onRawPromptChange={setRawPrompt}
            onProductAdd={(product) => {
              setProductRefs((current) =>
                current.some((item) => item.id === product.id)
                  ? current
                  : [...current, { id: product.id, name: product.name }],
              );
            }}
            onPersonaAdd={(persona) => {
              setPersonaRefs((current) =>
                current.some((item) => item.id === persona.id)
                  ? current
                  : [...current, { id: persona.id, name: persona.name }],
              );
            }}
            onPresetSelect={setPresetRef}
            onReferenceRemove={(type, id) => {
              if (type === 'product') {
                setProductRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              if (type === 'persona') {
                setPersonaRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              setPresetRef((current) => (current?.id === id ? null : current));
            }}
            onNegativePromptChange={setNegativePrompt}
            onExtraReferenceUrlAdd={(url) => {
              setExtraReferenceUrls((current) => (current.includes(url) ? current : [...current, url]));
            }}
            onExtraReferenceUrlRemove={(url) => {
              setExtraReferenceUrls((current) => current.filter((item) => item !== url));
            }}
          />

          <ControlBar
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              setCount(1);
            }}
            presets={presets}
            selectedPreset={presetRef}
            onPresetChange={setPresetRef}
            aspectRatio={aspectRatio}
            onAspectRatioChange={setAspectRatio}
            count={count}
            onCountChange={setCount}
            provider={provider}
            onProviderChange={(nextProvider) => {
              setProvider(nextProvider);
              setModel(getDefaultModelForProvider(nextProvider));
              const validRatios = getAspectRatiosForProvider(nextProvider);
              if (!validRatios.includes(aspectRatio as never)) {
                setAspectRatio('1:1');
              }
            }}
            model={model}
            onModelChange={setModel}
            quality={quality}
            onQualityChange={setQuality}
            outputFormat={outputFormat}
            onOutputFormatChange={setOutputFormat}
            background={background}
            onBackgroundChange={setBackground}
            onGenerate={handleGenerate}
            isGenerating={generationHook.loading}
            canGenerate={canGenerate}
            showMoreOptions={showMoreOptions}
            onShowMoreOptionsChange={setShowMoreOptions}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-full px-3 py-1">
              {mode === 'video' ? 'Video mode' : 'Image mode'}
            </Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">{provider === 'openai' ? 'OpenAI' : 'Gemini'} — {model}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Presets: {presets.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Products: {products.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Personas: {personas.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Recent generations: {generations.length}</Badge>
            {generationHook.error ? (
              <Badge variant="outline" className="rounded-full border-red-500/40 text-red-700 dark:text-red-300">
                {generationHook.error}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <OutputDetailView
        generation={resolvedSelectedGeneration}
        output={resolvedSelectedOutput}
        generations={generations}
        products={products}
        personas={personas}
        open={resolvedSelectedGeneration !== null && resolvedSelectedOutput !== null}
        onSelectOutput={({ generation, output }) => {
          setSelectedGenerationId(generation.id);
          setSelectedOutputId(output.id);
        }}
        onToggleFavorite={(generation, output) => {
          void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
        }}
        onCreateVariation={(generation, output) => {
          setMode('image');
          setRawPrompt(generation.rawPrompt || generation.prompt || '');
          setProductRefs((generation.product_ids ?? []).map((id) => {
            const p = products.find((product) => product.id === id);
            return { id, name: p?.name || id };
          }));
          setPersonaRefs((generation.persona_ids ?? []).map((id) => {
            const p = personas.find((persona) => persona.id === id);
            return { id, name: p?.name || id };
          }));
          setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
          setAspectRatio(generation.aspectRatio || '1:1');
          setProvider(generation.provider || 'gemini');
          setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
          if (output.mediaUrl) {
            setExtraReferenceUrls((prev) => (prev.includes(output.mediaUrl!) ? prev : [...prev, output.mediaUrl!]));
          }
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onCreateVideo={(generation, output) => {
          setMode('video');
          setRawPrompt(generation.rawPrompt || generation.prompt || '');
          setProductRefs((generation.product_ids ?? []).map((id) => {
            const p = products.find((product) => product.id === id);
            return { id, name: p?.name || id };
          }));
          setPersonaRefs((generation.persona_ids ?? []).map((id) => {
            const p = personas.find((persona) => persona.id === id);
            return { id, name: p?.name || id };
          }));
          setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
          setAspectRatio(generation.aspectRatio || '1:1');
          setProvider(generation.provider || 'gemini');
          setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
          if (output.mediaUrl) {
            setExtraReferenceUrls((prev) => (prev.includes(output.mediaUrl!) ? prev : [...prev, output.mediaUrl!]));
          }
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onDelete={(generation, output) => {
          void generationHook.deleteGeneration(generation.id);
        }}
        onSaveToWorkspace={(generation, output) => {
          handleSaveSingleToWorkspace(generation, output);
        }}
        onClose={() => {
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
      />
      <SaveToWorkspaceDialog
        open={showSaveDialog}
        onOpenChange={setShowSaveDialog}
        outputIds={selectedOutputIds}
      />
    </div>
  );
}
