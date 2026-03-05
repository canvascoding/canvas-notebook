/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Image as ImageIcon, Download, Loader2, Sparkles, Upload, X, AlertCircle } from 'lucide-react';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey?: () => Promise<boolean>;
      openSelectKey?: () => Promise<void>;
    };
  }
}

const ASPECT_RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
];

const MAX_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 10;
const SAMPLE_PROMPTS = [
  'Premium product shot of a minimalist skincare bottle on a marble pedestal, soft studio lighting, clean luxury branding',
  'Instagram ad creative for a summer travel campaign, bold typography space, vibrant tropical colors, modern marketing style',
  'Hero banner scene for a SaaS landing page, abstract 3D shapes, professional corporate palette, high-end tech aesthetic',
  'Food campaign visual with dramatic lighting, gourmet burger and fries, high contrast commercial photography look',
  'Fashion e-commerce editorial: streetwear model in urban setting, cinematic lighting, high-detail fabric textures',
  'Before-and-after style concept image for a home cleaning brand, split composition, bright and trustworthy tone',
];

interface ReferenceImage {
  id: string;
  base64: string;
  mimeType: string;
  previewUrl: string;
}

interface GenerationResult {
  id: number;
  loading: boolean;
  image: string | null;
  error: string | null;
}

export default function App() {
  const [hasKey, setHasKey] = useState(false);
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [referenceImageError, setReferenceImageError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageCount, setImageCount] = useState(MAX_IMAGE_COUNT);
  const [results, setResults] = useState<GenerationResult[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasKey(selected);
      } else {
        setHasKey(true);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      try {
        await window.aistudio.openSelectKey();
        setHasKey(true);
        setShowKeyDialog(false);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const availableSlots = MAX_REFERENCE_IMAGES - referenceImages.length;

    if (availableSlots <= 0) {
      setReferenceImageError(`Maximum of ${MAX_REFERENCE_IMAGES} reference images reached.`);
      e.target.value = '';
      return;
    }

    const filesToAdd = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      setReferenceImageError(`Only ${MAX_REFERENCE_IMAGES} reference images are allowed.`);
    } else {
      setReferenceImageError(null);
    }

    filesToAdd.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const match = result.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (match) {
          setReferenceImages(prev => [...prev, {
            id: Math.random().toString(36).substring(7),
            mimeType: match[1],
            base64: match[2],
            previewUrl: result
          }]);
        }
      };
      reader.readAsDataURL(file);
    });

    e.target.value = '';
  };

  const removeReferenceImage = (id: string) => {
    setReferenceImages(prev => prev.filter(img => img.id !== id));
    setReferenceImageError(null);
  };

  const generateSingleVariation = async (index: number, currentPrompt: string, currentImages: ReferenceImage[], currentRatio: string) => {
    try {
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("API Key not found");

      const ai = new GoogleGenAI({ apiKey });

      const parts: any[] = [];

      currentImages.forEach(img => {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          }
        });
      });

      if (currentPrompt.trim()) {
        parts.push({ text: currentPrompt });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio: currentRatio,
            imageSize: "1K"
          }
        }
      });

      let base64Image = null;
      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            base64Image = part.inlineData.data;
            break;
          }
        }
      }

      if (!base64Image) throw new Error("No image generated");

      setResults(prev => prev.map(r =>
        r.id === index ? { ...r, loading: false, image: base64Image } : r
      ));
    } catch (error: any) {
      console.error(`Error generating variation ${index}:`, error);
      setResults(prev => prev.map(r =>
        r.id === index ? { ...r, loading: false, error: error.message || "Generation failed" } : r
      ));
    }
  };

  const handleGenerate = async () => {
    const keySelected = await window.aistudio?.hasSelectedApiKey();
    if (!keySelected) {
      setShowKeyDialog(true);
      return;
    }

    if (!prompt.trim() && referenceImages.length === 0) return;

    setIsGenerating(true);

    const initialResults = Array.from({ length: imageCount }, (_, i) => ({
      id: i,
      loading: true,
      image: null,
      error: null
    }));
    setResults(initialResults);

    // Capture current state for the async calls
    const currentPrompt = prompt;
    const currentImages = [...referenceImages];
    const currentRatio = aspectRatio;

    await Promise.all(
      Array.from({ length: imageCount }, (_, i) =>
        generateSingleVariation(i, currentPrompt, currentImages, currentRatio)
      )
    );

    setIsGenerating(false);
  };

  const downloadImage = (base64: string, index: number) => {
    const link = document.createElement('a');
    link.href = `data:image/jpeg;base64,${base64}`;
    link.download = `generation-${index + 1}-${Date.now()}.jpg`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col md:flex-row font-sans">
      {/* Sidebar Controls */}
      <div className="w-full md:w-96 bg-zinc-900 border-r border-zinc-800 flex flex-col h-screen overflow-y-auto">
        <div className="p-6 border-b border-zinc-800">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-400" />
            Studio Generator
          </h1>
          <p className="text-sm text-zinc-400 mt-1">Generate up to {MAX_IMAGE_COUNT} variations per prompt</p>
        </div>

        <div className="p-6 flex-1 flex flex-col gap-6">
          {/* Prompt Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to see..."
              className="w-full h-32 bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none placeholder-zinc-600"
            />
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">Marketing Prompt Ideas</p>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_PROMPTS.map((examplePrompt) => (
                  <button
                    key={examplePrompt}
                    type="button"
                    onClick={() => setPrompt(examplePrompt)}
                    className="text-left text-xs px-2.5 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-300 transition-colors"
                  >
                    {examplePrompt}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Number of Images */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Number of Images</label>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: MAX_IMAGE_COUNT }, (_, i) => i + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setImageCount(count)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    imageCount === count
                      ? 'bg-indigo-500 text-white'
                      : 'bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500">Default is {MAX_IMAGE_COUNT}. Maximum is {MAX_IMAGE_COUNT}.</p>
          </div>

          {/* Reference Images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-zinc-300">Reference Images <span className="text-zinc-500 font-normal">(Optional)</span></label>
              <span className="text-xs text-zinc-500">{referenceImages.length}/{MAX_REFERENCE_IMAGES} added</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {referenceImages.map((img) => (
                <div key={img.id} className="relative aspect-square rounded-lg overflow-hidden group border border-zinc-800">
                  <img src={img.previewUrl} alt="Reference" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeReferenceImage(img.id)}
                    className="absolute top-1 right-1 bg-black/60 hover:bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}

              <label className={`aspect-square rounded-lg border-2 border-dashed flex flex-col items-center justify-center transition-colors ${
                referenceImages.length >= MAX_REFERENCE_IMAGES
                  ? 'border-zinc-800 bg-zinc-900 cursor-not-allowed opacity-50'
                  : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/50 cursor-pointer'
              }`}>
                <Upload className="w-5 h-5 text-zinc-500 mb-1" />
                <span className="text-xs text-zinc-500">Upload</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleImageUpload}
                  disabled={referenceImages.length >= MAX_REFERENCE_IMAGES}
                />
              </label>
            </div>
            {referenceImageError && (
              <p className="text-xs text-amber-400">{referenceImageError}</p>
            )}
          </div>

          {/* Aspect Ratio */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Aspect Ratio</label>
            <div className="flex flex-wrap gap-2">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  onClick={() => setAspectRatio(ratio.value)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    aspectRatio === ratio.value
                      ? 'bg-indigo-500 text-white'
                      : 'bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Generate Button */}
        <div className="p-6 border-t border-zinc-800 bg-zinc-900 sticky bottom-0">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || (!prompt.trim() && referenceImages.length === 0)}
            className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium py-3 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Generate {imageCount} {imageCount === 1 ? 'Image' : 'Images'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Content - Results Grid */}
      <div className="flex-1 p-6 md:p-8 overflow-y-auto h-screen">
        {results.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500">
            <ImageIcon className="w-16 h-16 mb-4 opacity-20" />
            <p className="text-lg font-medium text-zinc-400">Ready to create</p>
            <p className="text-sm">Enter a prompt or upload images to generate your variations.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {results.map((result) => (
              <div
                key={result.id}
                className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col relative group"
                style={{
                  aspectRatio: aspectRatio.replace(':', '/')
                }}
              >
                {result.loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/50">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-4" />
                    <div className="h-2 w-24 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 w-1/2 animate-[ping_1.5s_ease-in-out_infinite]"></div>
                    </div>
                  </div>
                ) : result.error ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 p-6 text-center bg-red-950/20">
                    <AlertCircle className="w-8 h-8 mb-2" />
                    <p className="text-sm">{result.error}</p>
                  </div>
                ) : result.image ? (
                  <>
                    <img
                      src={`data:image/jpeg;base64,${result.image}`}
                      alt={`Generation ${result.id + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-sm">
                      <button
                        onClick={() => downloadImage(result.image!, result.id)}
                        className="bg-white text-black px-4 py-2 rounded-full font-medium flex items-center gap-2 hover:scale-105 transition-transform"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API Key Dialog */}
      {showKeyDialog && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-xl font-semibold mb-2 text-white">API Key Required</h3>
            <p className="text-zinc-400 mb-6 text-sm">
              To generate images with Gemini 3.1 Flash Image, you need to select a Google Cloud project with billing enabled.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowKeyDialog(false)}
                className="px-4 py-2 text-zinc-400 hover:text-white transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleSelectKey}
                className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors text-sm font-medium"
              >
                Select API Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
