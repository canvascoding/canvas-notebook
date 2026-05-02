'use client';

import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { ArrowUpRight, ImageOff, Images } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { StudioProduct } from '../../types/models';

interface ProductCardProps {
  product: StudioProduct;
}

export function ProductCard({ product }: ProductCardProps) {
  const t = useTranslations('studio');
  const [imgError, setImgError] = useState(false);

  const thumbnailUrl = product.images?.[0]
    ? `/api/studio/products/${product.id}/images/${product.images[0].id}?size=thumb`
    : null;

  return (
    <Link href={`/studio/models/${product.id}?type=product`} className="block">
      <Card className="group flex h-full flex-col overflow-hidden border border-border bg-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-md">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
          {thumbnailUrl && !imgError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailUrl}
              alt={product.name}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-background">
              <ImageOff className="h-9 w-9 text-muted-foreground/45" />
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent opacity-80 transition-opacity group-hover:opacity-100" />
          <div className="absolute bottom-3 left-3 flex items-center gap-1.5 border border-white/20 bg-black/45 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
            <Images className="h-3.5 w-3.5" />
            {t('modelLibrary.imageCount', { count: product.imageCount })}
          </div>
          <div className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center border border-white/25 bg-white/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            <ArrowUpRight className="h-4 w-4" />
          </div>
        </div>
        <div className="flex min-h-24 flex-col justify-between gap-3 p-4">
          <div>
            <p className="truncate text-base font-semibold text-foreground">{product.name}</p>
            {product.description ? (
              <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{product.description}</p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Produkt-Referenz</p>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}
