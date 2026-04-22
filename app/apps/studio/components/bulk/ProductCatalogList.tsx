'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Search, ImageIcon, Boxes } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { StudioProduct } from '../../types/models';

const MAX_SELECT = 20;

interface ProductCatalogListProps {
  products: StudioProduct[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  loading?: boolean;
}

export function ProductCatalogList({
  products,
  selectedIds,
  onSelectionChange,
  loading,
}: ProductCatalogListProps) {
  const t = useTranslations('studio.bulk');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return products;
    const q = search.toLowerCase();
    return products.filter((p) => p.name.toLowerCase().includes(q));
  }, [products, search]);

  const toggleProduct = (productId: string) => {
    if (selectedIds.includes(productId)) {
      onSelectionChange(selectedIds.filter((id) => id !== productId));
    } else if (selectedIds.length < MAX_SELECT) {
      onSelectionChange([...selectedIds, productId]);
    }
  };

  const selectAll = () => {
    const available = filtered.map((p) => p.id);
    const newSelection = [...new Set([...selectedIds, ...available])].slice(0, MAX_SELECT);
    onSelectionChange(newSelection);
  };

  const clearAll = () => {
    onSelectionChange([]);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Boxes className="h-5 w-5 animate-pulse" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{t('loadingProducts')}</p>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Boxes className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{t('emptyProducts')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
            {t('selectedCount', { selected: selectedIds.length, max: MAX_SELECT })}
          </Badge>
          <button
            type="button"
            onClick={selectAll}
            className="text-xs font-medium text-primary hover:underline"
          >
            {t('selectAll')}
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="text-xs font-medium text-muted-foreground hover:underline"
          >
            {t('clearAll')}
          </button>
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-xl border border-border/60">
        {filtered.map((product) => {
          const isSelected = selectedIds.includes(product.id);
          return (
            <button
              key={product.id}
              type="button"
              onClick={() => toggleProduct(product.id)}
              className={`flex w-full items-center gap-3 border-b border-border/50 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/50 ${
                isSelected ? 'bg-primary/5' : ''
              }`}
            >
              <div
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/30'
                }`}
              >
                {isSelected && <span className="text-[10px]">&#10003;</span>}
              </div>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                {product.images?.[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/studio/products/${product.id}/images/${product.images[0].id}?size=thumb`}
                    alt=""
                    className="h-8 w-8 rounded object-cover"
                  />
                ) : (
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{product.name}</div>
                <div className="text-xs text-muted-foreground">
                  {product.imageCount} image(s)
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
