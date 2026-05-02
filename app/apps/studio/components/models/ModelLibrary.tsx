'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect } from 'react';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioStyles } from '../../hooks/useStudioStyles';
import { ProductCard } from './ProductCard';
import { PersonaCard } from './PersonaCard';
import { StyleCard } from './StyleCard';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Palette, Package, Plus, Search, UserRound } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';

type TabKey = 'products' | 'personas' | 'styles';

const tabConfig = {
  products: { icon: Package },
  personas: { icon: UserRound },
  styles: { icon: Palette },
} satisfies Record<TabKey, { icon: typeof Package }>;

export function ModelLibrary() {
  const t = useTranslations('studio');
  const [activeTab, setActiveTab] = useState<TabKey>('products');
  const [search, setSearch] = useState('');
  const router = useRouter();

  const {
    products,
    loading: productsLoading,
    fetchProducts,
  } = useStudioProducts();
  const {
    personas,
    loading: personasLoading,
    fetchPersonas,
  } = useStudioPersonas();
  const {
    styles,
    loading: stylesLoading,
    fetchStyles,
  } = useStudioStyles();

  useEffect(() => {
    fetchProducts(search);
  }, [search, fetchProducts]);

  useEffect(() => {
    fetchPersonas(search);
  }, [search, fetchPersonas]);

  useEffect(() => {
    fetchStyles(search);
  }, [search, fetchStyles]);

  const handleCreate = () => {
    const type = activeTab === 'personas' ? 'persona' : activeTab === 'styles' ? 'style' : 'product';
    router.push(`/studio/models/new?type=${type}`);
  };

  const tabs = (['products', 'personas', 'styles'] as TabKey[]).map((tab) => ({
    key: tab,
    label: t(`modelLibrary.${tab}`),
    count: tab === 'products' ? products.length : tab === 'personas' ? personas.length : styles.length,
    Icon: tabConfig[tab].icon,
  }));

  const createLabel = activeTab === 'products'
    ? t('modelLibrary.newProduct')
    : activeTab === 'personas'
      ? t('modelLibrary.newPersona')
      : t('modelLibrary.newStyle');

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-4 border-b border-border/80 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Library</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">{t('tabs.models')}</h1>
          </div>
          <div className="inline-flex border border-border bg-card p-1 shadow-sm">
            {tabs.map(({ key, label, count, Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex min-h-10 items-center gap-2 px-3 text-sm font-medium transition-colors hover:bg-accent/60 hover:text-foreground sm:px-4',
                activeTab === key ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              <span className={cn(
                'ml-1 border px-1.5 py-0.5 text-[11px] leading-none',
                activeTab === key ? 'border-primary-foreground/30 text-primary-foreground/80' : 'border-border text-muted-foreground',
              )}>
                {count}
              </span>
            </button>
          ))}
          </div>
        </div>
        <Button onClick={handleCreate} className="h-11 gap-2 px-5 shadow-sm lg:self-start">
          <Plus className="h-4 w-4" />
          {createLabel}
        </Button>
      </div>

      <div className="relative border border-border bg-card shadow-sm">
        <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('modelLibrary.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-12 border-0 bg-transparent pl-12 text-base shadow-none focus-visible:ring-0"
        />
      </div>

      {activeTab === 'products' && (
        productsLoading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : products.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 border border-dashed border-border bg-card/60 p-8 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyProductTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyProductDescription')}</p>
            <Button onClick={handleCreate} size="sm" className="mt-4 gap-2">
              <Plus className="h-4 w-4" />
              {createLabel}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )
      )}

      {activeTab === 'personas' && (
        personasLoading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : personas.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 border border-dashed border-border bg-card/60 p-8 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyPersonaTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyPersonaDescription')}</p>
            <Button onClick={handleCreate} size="sm" className="mt-4 gap-2">
              <Plus className="h-4 w-4" />
              {createLabel}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {personas.map((persona) => (
              <PersonaCard key={persona.id} persona={persona} />
            ))}
          </div>
        )
      )}

      {activeTab === 'styles' && (
        stylesLoading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : styles.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 border border-dashed border-border bg-card/60 p-8 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyStyleTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyStyleDescription')}</p>
            <Button onClick={handleCreate} size="sm" className="mt-4 gap-2">
              <Plus className="h-4 w-4" />
              {createLabel}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {styles.map((style) => (
              <StyleCard key={style.id} style={style} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
