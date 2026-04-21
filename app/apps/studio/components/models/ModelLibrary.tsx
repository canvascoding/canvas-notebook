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
import { Plus, Search } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';

type TabKey = 'products' | 'personas' | 'styles';

export function ModelLibrary() {
  const t = useTranslations('studio');
  const [activeTab, setActiveTab] = useState<TabKey>('products');
  const [search, setSearch] = useState('');
  const router = useRouter();

  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();

  useEffect(() => {
    productsHook.fetchProducts(search);
  }, [search, productsHook]);

  useEffect(() => {
    personasHook.fetchPersonas(search);
  }, [search, personasHook]);

  useEffect(() => {
    stylesHook.fetchStyles(search);
  }, [search, stylesHook]);

  const handleCreate = () => {
    const type = activeTab === 'personas' ? 'persona' : activeTab === 'styles' ? 'style' : 'product';
    router.push(`/studio/models/new?type=${type}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-1 border-b border-border">
          {(['products', 'personas', 'styles'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'relative px-4 py-2 text-sm font-medium transition-colors hover:text-foreground',
                activeTab === tab ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`modelLibrary.${tab}`)}
              {activeTab === tab && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </div>
        <Button onClick={handleCreate} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {activeTab === 'products' ? t('modelLibrary.newProduct') : activeTab === 'personas' ? t('modelLibrary.newPersona') : t('modelLibrary.newStyle')}
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('modelLibrary.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {activeTab === 'products' && (
        productsHook.loading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : productsHook.products.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyProductTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyProductDescription')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {productsHook.products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )
      )}

      {activeTab === 'personas' && (
        personasHook.loading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : personasHook.personas.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyPersonaTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyPersonaDescription')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {personasHook.personas.map((persona) => (
              <PersonaCard key={persona.id} persona={persona} />
            ))}
          </div>
        )
      )}

      {activeTab === 'styles' && (
        stylesHook.loading ? (
          <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : stylesHook.styles.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('modelLibrary.emptyStyleTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('modelLibrary.emptyStyleDescription')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {stylesHook.styles.map((style) => (
              <StyleCard key={style.id} style={style} />
            ))}
          </div>
        )
      )}
    </div>
  );
}