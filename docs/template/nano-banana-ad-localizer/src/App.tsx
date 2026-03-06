/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Globe, Image as ImageIcon, Download, RefreshCw, Loader2, Sparkles, ChevronDown, Upload, X } from 'lucide-react';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey?: () => Promise<boolean>;
      openSelectKey?: () => Promise<void>;
    };
  }
}

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9', css: 'aspect-video' },
  { label: '1:1', value: '1:1', css: 'aspect-square' },
  { label: '9:16', value: '9:16', css: 'aspect-[9/16]' },
  { label: '4:3', value: '4:3', css: 'aspect-[4/3]' },
  { label: '3:4', value: '3:4', css: 'aspect-[3/4]' },
];

// Google-approved country list (ISO 3166-1)
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
  'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain',
  'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
  'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
  'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic',
  'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
  'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France',
  'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala',
  'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary', 'Iceland',
  'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Jamaica',
  'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kuwait', 'Kyrgyzstan',
  'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein',
  'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali',
  'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia',
  'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar',
  'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger',
  'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau',
  'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis',
  'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
  'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles',
  'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia',
  'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan',
  'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania',
  'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia',
  'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican City',
  'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
];

interface Result {
  market: string;
  loading: boolean;
  image: string | null;
  error: string | null;
}

export default function App() {
  const [hasKey, setHasKey] = useState(false);
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadedReference, setUploadedReference] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [countrySearch, setCountrySearch] = useState('');
  const [showCountryDropdown, setShowCountryDropdown] = useState(false);
  const [activeCountryIndex, setActiveCountryIndex] = useState(-1);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasKey(selected);
      } else {
        setHasKey(true); // Fallback if not in AI Studio
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

  const toggleMarket = (m: string) => {
    setSelectedMarkets(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    );
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setUploadedReference(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const generateForMarket = async (market: string, refImage: string, ratio: string = '16:9'): Promise<string | null> => {
    try {
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("API Key not found");

      const ai = new GoogleGenAI({ apiKey });
      const model = 'gemini-3.1-flash-image-preview';
      const contents = [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: refImage,
              },
            },
            {
              text: `Translate all text in this advertisement image to the language of ${market}. ONLY translate the text - do not add any cultural imagery, flags, national symbols, or stereotypical visual elements. Keep the image, composition, styling, colors, and all visual elements exactly the same as the original. The only change should be the language of the text.`,
            },
          ],
        },
      ];

      const config = {
        responseModalities: ['IMAGE', 'TEXT'],
        aspectRatio: ratio,
      };

      const response = await ai.models.generateContentStream({
        model,
        config,
        contents,
      });

      let base64Image = null;
      for await (const chunk of response) {
        if (!chunk.candidates || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
          continue;
        }
        for (const part of chunk.candidates[0].content.parts) {
          if (part.inlineData) {
            base64Image = part.inlineData.data;
            break;
          }
        }
        if (base64Image) break;
      }
      return base64Image;
    } catch (error) {
      console.error(`Error generating for ${market}:`, error);
      throw error;
    }
  };

  const handleGenerate = async () => {
    // Final key check before spending tokens
    const keySelected = await window.aistudio?.hasSelectedApiKey();
    if (!keySelected) {
      setShowKeyDialog(true);
      return;
    }

    if (!uploadedReference || selectedMarkets.length === 0) return;

    setIsGenerating(true);
    setResults([]);

    try {
      const initialResults = selectedMarkets.map(m => ({
        market: m,
        loading: true,
        image: null,
        error: null
      }));
      setResults(initialResults);

      await Promise.all(
        selectedMarkets.map(async (market) => {
          try {
            const image = await generateForMarket(market, uploadedReference, aspectRatio);
            setResults(prev => prev.map(r =>
              r.market === market
                ? { ...r, loading: false, image, error: image ? null : 'Failed' }
                : r
            ));
          } catch (err: any) {
            const msg = err.message || "";
            if (msg.includes("Requested entity was not found") || msg.includes("404")) {
              setShowKeyDialog(true);
            }
            setResults(prev => prev.map(r =>
              r.market === market
                ? { ...r, loading: false, error: 'API Key Error' }
                : r
            ));
          }
        })
      );
    } catch (err: any) {
      console.error(err);
      const msg = err.message || "";
      if (msg.includes("Requested entity was not found") || msg.includes("404")) {
        setShowKeyDialog(true);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = () => {
    // Export localized images
    results.forEach((res) => {
      if (res.image) {
        const a = document.createElement('a');
        a.href = `data:image/jpeg;base64,${res.image}`;
        a.download = `localized_ad_${res.market.toLowerCase().replace(/\s+/g, '_')}.jpg`;
        a.click();
      }
    });
  };

  const handleReset = () => {
    setSelectedMarkets([]);
    setResults([]);
    setUploadedReference(null);
  };

  return (
    <main className="grid grid-cols-1 lg:grid-cols-2 min-h-screen bg-[#f5f5f4] text-[#0a0a0a] font-sans">
      {/* Left Pane */}
      <div className="p-8 lg:p-16 pt-8 flex flex-col justify-start border-r border-[#0a0a0a]/10">

        <h1 className="text-[48px] xl:text-[64px] font-semibold tracking-tight leading-[0.88] mb-8">
          Ad Localizer
        </h1>

        <div className="space-y-6 max-w-md">

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-4">1. Upload Your Ad</label>
            {uploadedReference ? (
              <div className="relative rounded-lg overflow-hidden border border-gray-300">
                <img
                  src={`data:image/jpeg;base64,${uploadedReference}`}
                  alt="Uploaded reference"
                  className="w-full max-h-64 object-contain"
                />
                <button
                  onClick={() => setUploadedReference(null)}
                  className="absolute top-2 right-2 w-8 h-8 bg-black/70 text-white rounded-full flex items-center justify-center hover:bg-black transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <label
                htmlFor="ad-upload"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const input = document.getElementById('ad-upload') as HTMLInputElement;
                    input?.click();
                  }
                }}
                className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-[#0a0a0a] hover:bg-gray-50 transition-colors focus:ring-2 focus:ring-[#0a0a0a] focus:outline-none"
              >
                <Upload className="w-8 h-8 text-gray-400 mb-2" />
                <span className="text-sm text-gray-500">Click to upload your ad image</span>
                <input
                  id="ad-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </label>
            )}
            <p className="text-[10px] text-gray-400 mt-2">By using this feature, you confirm that you have the necessary rights to any content that you upload. Do not generate content that infringes on others' intellectual property or privacy rights. Your use of this generative AI service is subject to our Prohibited Use Policy.</p>
          </div>

          <div className="relative">
            <label className="block text-xs font-bold uppercase tracking-widest mb-4">2. Target Market</label>

            {/* Selected country tags */}
            {selectedMarkets.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {selectedMarkets.map((market) => (
                  <span
                    key={market}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#0a0a0a] text-white text-sm rounded-full"
                  >
                    {market}
                    <button
                      onClick={() => setSelectedMarkets(prev => prev.filter(m => m !== market))}
                      className="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Autocomplete input */}
            <div 
              className="relative"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setShowCountryDropdown(false);
                }
              }}
            >
              <input
                type="text"
                className="w-full bg-transparent border-b-2 border-[#0a0a0a] pb-2 focus:outline-none text-lg placeholder:text-gray-400"
                placeholder="Type to search countries..."
                value={countrySearch}
                onChange={(e) => {
                  setCountrySearch(e.target.value);
                  setShowCountryDropdown(true);
                  setActiveCountryIndex(-1);
                }}
                onFocus={() => setShowCountryDropdown(true)}
                onKeyDown={(e) => {
                  const filtered = COUNTRIES.filter(country =>
                    country.toLowerCase().includes(countrySearch.toLowerCase()) &&
                    !selectedMarkets.includes(country)
                  ).slice(0, 8);

                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveCountryIndex(prev => (prev < filtered.length - 1 ? prev + 1 : prev));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveCountryIndex(prev => (prev > 0 ? prev - 1 : prev));
                  } else if (e.key === 'Enter' && activeCountryIndex >= 0) {
                    e.preventDefault();
                    const country = filtered[activeCountryIndex];
                    if (country) {
                      setSelectedMarkets(prev => [...prev, country]);
                      setCountrySearch('');
                      setShowCountryDropdown(false);
                      setActiveCountryIndex(-1);
                    }
                  } else if (e.key === 'Escape') {
                    setShowCountryDropdown(false);
                  }
                }}
              />

              {/* Dropdown suggestions */}
              {showCountryDropdown && countrySearch && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {COUNTRIES
                    .filter(country =>
                      country.toLowerCase().includes(countrySearch.toLowerCase()) &&
                      !selectedMarkets.includes(country)
                    )
                    .slice(0, 8)
                    .map((country, idx) => (
                      <button
                        key={country}
                        className={`w-full px-4 py-2 text-left text-sm transition-colors first:rounded-t-lg last:rounded-b-lg focus:bg-gray-100 focus:outline-none ${activeCountryIndex === idx ? 'bg-gray-100' : 'hover:bg-gray-100'
                          }`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          setSelectedMarkets(prev => [...prev, country]);
                          setCountrySearch('');
                          setShowCountryDropdown(false);
                          setActiveCountryIndex(-1);
                        }}
                      >
                        {country}
                      </button>
                    ))}
                  {COUNTRIES.filter(country =>
                    country.toLowerCase().includes(countrySearch.toLowerCase()) &&
                    !selectedMarkets.includes(country)
                  ).length === 0 && (
                      <div className="px-4 py-2 text-sm text-gray-500">No matching countries</div>
                    )}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest mb-4">3. Aspect Ratio</label>
            <div className="flex flex-wrap gap-2">
              {ASPECT_RATIOS.map(ar => (
                <button
                  key={ar.value}
                  onClick={() => setAspectRatio(ar.value)}
                  className={`px-4 py-2 rounded-full border border-[#0a0a0a] text-sm transition-all ${aspectRatio === ar.value ? 'bg-[#0a0a0a] text-white' : 'hover:bg-black/5'
                    }`}
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={isGenerating || !uploadedReference || selectedMarkets.length === 0}
            className="w-full py-5 bg-[#0a0a0a] text-white font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-3 disabled:opacity-50 hover:bg-black/80 transition-colors"
          >
            {isGenerating ? <Loader2 className="animate-spin w-5 h-5" /> : <Globe className="w-5 h-5" />}
            LOCALIZE
          </button>
        </div>
      </div>

      {/* Right Pane */}
      <div className="bg-white relative h-screen overflow-hidden flex flex-col">
        {results.length > 0 ? (
          <>
            <div className="absolute top-8 right-8 flex gap-4 z-20">
              <div className="relative group">
                <button
                  onClick={handleExport}
                  aria-label="Export All"
                  className="w-12 h-12 rounded-full border border-[#0a0a0a] flex items-center justify-center hover:bg-black/5 bg-white transition-colors focus:ring-2 focus:ring-[#0a0a0a] focus:outline-none"
                >
                  <Download className="w-5 h-5" />
                </button>
                <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-[#0a0a0a] text-white text-[10px] font-bold uppercase tracking-widest rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-lg">
                  Export All
                </span>
              </div>
              <div className="relative group">
                <button
                  onClick={handleReset}
                  aria-label="New Campaign"
                  className="w-12 h-12 rounded-full border border-[#0a0a0a] flex items-center justify-center hover:bg-black/5 bg-white transition-colors focus:ring-2 focus:ring-[#0a0a0a] focus:outline-none"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
                <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-[#0a0a0a] text-white text-[10px] font-bold uppercase tracking-widest rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-lg">
                  New Campaign
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-8 lg:p-16 pt-24 space-y-8">
              {/* Localized Results */}
              {results.map((res, i) => (
                <div key={i} className="relative group rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                  <div className="absolute top-4 left-4 bg-white/90 backdrop-blur px-4 py-2 text-xs font-bold uppercase tracking-widest z-10 shadow-sm rounded-md">
                    {res.market}
                  </div>
                  {res.image && (
                    <button
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = `data:image/jpeg;base64,${res.image}`;
                        a.download = `localized_ad_${res.market.toLowerCase().replace(/\s+/g, '_')}.jpg`;
                        a.click();
                      }}
                      title={`Download ${res.market}`}
                      className="absolute top-4 right-4 w-10 h-10 rounded-full border border-[#0a0a0a] flex items-center justify-center hover:bg-black/5 bg-white/90 backdrop-blur transition-colors z-10 shadow-sm"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  )}
                  {res.loading ? (
                    <div className="aspect-video flex flex-col items-center justify-center text-gray-400 gap-4">
                      <Loader2 className="w-8 h-8 animate-spin" />
                      <span className="text-xs uppercase tracking-widest font-bold">Localizing...</span>
                    </div>
                  ) : res.image ? (
                    <img src={`data:image/jpeg;base64,${res.image}`} alt={res.market} className="w-full object-contain" />
                  ) : (
                    <div className="aspect-video flex items-center justify-center text-red-500 text-sm font-medium">
                      Failed to generate for {res.market}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-12 relative">
            <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0a0a0a 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>
            <div className="text-center max-w-sm relative z-10">
              <div className="w-24 h-24 mx-auto border border-[#0a0a0a] rounded-full flex items-center justify-center mb-8">
                <ImageIcon className="w-8 h-8 text-[#0a0a0a]" />
              </div>
              <h3 className="text-xl font-semibold mb-2">Ready to Scale</h3>
              <p className="text-gray-500 text-sm">Define your master concept and select target markets to generate localized assets instantly.</p>
            </div>
          </div>
        )}
      </div>
      
      {/* API Key Selection Modal */}
      {showKeyDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl border border-black/5 p-8 text-center animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 mx-auto border-2 border-[#0a0a0a] rounded-full flex items-center justify-center mb-6">
              <Globe className="w-6 h-6 text-[#0a0a0a]" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight mb-4">API Key Required</h2>
            <p className="text-gray-600 mb-8 text-sm leading-relaxed">
              To continue generating high-quality localized ads, please select a paid Gemini API key. This ensures the best performance and image quality.
            </p>
            <div className="space-y-3">
              <button
                onClick={handleSelectKey}
                className="w-full py-4 bg-[#0a0a0a] text-white font-bold text-sm uppercase tracking-widest rounded-lg hover:bg-black/80 transition-colors"
              >
                Select API Key
              </button>
              <button
                onClick={() => setShowKeyDialog(false)}
                className="w-full py-2 text-gray-400 text-xs uppercase tracking-widest font-bold hover:text-gray-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
