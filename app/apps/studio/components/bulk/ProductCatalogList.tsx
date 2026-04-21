'use client';

import { useState, useMemo } from 'react';
import { Search, ImageIcon } from 'lucide-react';
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="rounded-full">
            {selectedIds.length}/{MAX_SELECT} selected
          </Badge>
          <button
            type="button"
            onClick={selectAll}
            className="text-xs text-primary hover:underline"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:underline"
          >
            Clear
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading products...</div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No products found</div>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {filtered.map((product) => {
            const isSelected = selectedIds.includes(product.id);
            return (
              <button
                key={product.id}
                type="button"
                onClick={() => toggleProduct(product.id)}
                className={`flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/50 ${
                  isSelected ? 'bg-primary/5' : ''
                }`}
              >
                <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                }`}>
                  {isSelected && <span className="text-[10px]">&#10003;</span>}
                </div>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                  {product.thumbnailPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/studio/products/${product.id}/thumbnail`} alt="" className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{product.name}</div>
                  <div className="text-xs text-muted-foreground">{product.imageCount} image(s)</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}