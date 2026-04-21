'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { PresetCard } from './PresetCard';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, Search } from 'lucide-react';
import type { StudioPreset } from '../../types/presets';

type CategoryKey = 'all' | 'fashion' | 'product' | 'food' | 'lifestyle' | 'beauty' | 'tech' | 'interior' | 'automotive';

const categories: { key: CategoryKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'fashion', label: 'Fashion' },
  { key: 'product', label: 'Product' },
  { key: 'food', label: 'Food' },
  { key: 'lifestyle', label: 'Lifestyle' },
  { key: 'beauty', label: 'Beauty' },
  { key: 'tech', label: 'Tech' },
  { key: 'interior', label: 'Interior' },
  { key: 'automotive', label: 'Automotive' },
];

export function PresetLibrary() {
  const t = useTranslations('studio');
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('all');
  const [search, setSearch] = useState('');
  const { presets, loading, error, fetchPresets } = useStudioPresets();

  useEffect(() => {
    fetchPresets(activeCategory === 'all' ? undefined : activeCategory);
  }, [activeCategory, fetchPresets]);

  const filteredPresets = presets.filter((preset: StudioPreset) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      preset.name.toLowerCase().includes(q) ||
      preset.description?.toLowerCase().includes(q) ||
      preset.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  const handleCreate = () => {
    router.push('/studio/presets/new');
  };

  const handleEdit = (presetId: string) => {
    router.push(`/studio/presets/${presetId}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t('tabs.presets')}</h1>
        </div>
        <Button onClick={handleCreate} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          New Studio Preset
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex gap-1 border-b border-border overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={cn(
                'relative px-4 py-2 text-sm font-medium transition-colors hover:text-foreground whitespace-nowrap',
                activeCategory === cat.key ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {cat.label}
              {activeCategory === cat.key && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search presets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {loading && (
        <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
      )}

      {error && (
        <p className="py-8 text-center text-destructive">{error}</p>
      )}

      {!loading && !error && filteredPresets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-sm font-medium text-muted-foreground">No presets yet</p>
          <p className="text-xs text-muted-foreground">Create your first studio preset to start generating images with custom block compositions.</p>
          <Button onClick={handleCreate} size="sm" className="mt-4 gap-2">
            <Plus className="h-4 w-4" />
            New Studio Preset
          </Button>
        </div>
      )}

      {!loading && !error && filteredPresets.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filteredPresets.map((preset: StudioPreset) => (
            <PresetCard key={preset.id} preset={preset} onClick={() => handleEdit(preset.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
