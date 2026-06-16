'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Package2,
  Plus,
  Search,
  UserRound,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import type { StudioPersona, StudioProduct, StudioStyle } from '../../types/models';

export type ReferenceCategory = 'product' | 'persona' | 'style';

interface ReferenceOption {
  id: string;
  name: string;
  description?: string | null;
  thumbnailPath?: string | null;
  imageCount?: number;
  images?: {
    id: string;
    filePath: string;
    sortOrder: number;
  }[];
}

interface ReferenceOptionGridProps<T extends ReferenceOption> {
  items: T[];
  emptyText: string;
  createAction: {
    label: string;
    onClick: () => void;
  };
  fallbackIcon: React.ReactNode;
  isLoading: boolean;
  onSelect: (item: T) => void;
}

interface ModelReferencePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  productsLoading: boolean;
  personasLoading: boolean;
  stylesLoading: boolean;
  selectedProductIds: string[];
  selectedPersonaIds: string[];
  selectedStyleIds: string[];
  fetchProducts: () => Promise<void>;
  fetchPersonas: () => Promise<void>;
  fetchStyles: () => Promise<void>;
  fileReferenceCount: number;
  fileReferenceLimit: number;
  onImageReferenceClick: () => void;
  onProductAdd: (product: StudioProduct) => void;
  onPersonaAdd: (persona: StudioPersona) => void;
  onStyleAdd: (style: StudioStyle) => void;
}

function getReferenceImagePaths(item: ReferenceOption) {
  const paths = (item.images ?? [])
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((image) => image.filePath)
    .filter(Boolean);

  if (paths.length > 0) return paths;
  return item.thumbnailPath ? [item.thumbnailPath] : [];
}

function filterReferenceOptions<T extends ReferenceOption>(items: T[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return items;

  return items.filter((item) => {
    if (item.name.toLowerCase().includes(query)) return true;
    if (item.description?.toLowerCase().includes(query)) return true;
    return false;
  });
}

function ReferenceTile<T extends ReferenceOption>({
  item,
  fallbackIcon,
  onSelect,
}: {
  item: T;
  fallbackIcon: React.ReactNode;
  onSelect: (item: T) => void;
}) {
  const imagePaths = useMemo(() => getReferenceImagePaths(item), [item]);
  const [imageIndex, setImageIndex] = useState(0);
  const [preloadNextImage, setPreloadNextImage] = useState(false);
  const safeImageIndex = imagePaths.length > 0 ? Math.min(imageIndex, imagePaths.length - 1) : 0;
  const currentImage = imagePaths[safeImageIndex];
  const nextImage = imagePaths.length > 1 ? imagePaths[(safeImageIndex + 1) % imagePaths.length] : null;
  const hasMultipleImages = imagePaths.length > 1;

  const handleNavigateImage = (event: React.MouseEvent, direction: -1 | 1) => {
    event.preventDefault();
    event.stopPropagation();
    setPreloadNextImage(true);
    setImageIndex((current) => {
      if (!hasMultipleImages) return current;
      return (current + direction + imagePaths.length) % imagePaths.length;
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onMouseEnter={() => setPreloadNextImage(true)}
      onFocus={() => setPreloadNextImage(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(item);
        }
      }}
      className="group flex h-full cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {currentImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toPreviewUrl(currentImage, 420)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            onError={(event) => {
              (event.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            {fallbackIcon}
          </div>
        )}
        {preloadNextImage && nextImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toPreviewUrl(nextImage, 420)}
            alt=""
            aria-hidden="true"
            className="sr-only"
            loading="eager"
          />
        ) : null}
        {hasMultipleImages ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={(event) => handleNavigateImage(event, -1)}
              className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm opacity-100 transition hover:bg-black/65 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={(event) => handleNavigateImage(event, 1)}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm opacity-100 transition hover:bg-black/65 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
              {safeImageIndex + 1}/{imagePaths.length}
            </div>
          </>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 px-3 py-2.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{item.name}</p>
        {item.description ? (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
    </div>
  );
}

function CreateReferenceTile({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[168px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-background p-4 text-center text-sm font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-current/25 bg-card">
        <Plus className="h-5 w-5" />
      </span>
      {label}
    </button>
  );
}

function ReferenceOptionGrid<T extends ReferenceOption>({
  items,
  emptyText,
  createAction,
  fallbackIcon,
  isLoading,
  onSelect,
}: ReferenceOptionGridProps<T>) {
  return (
    <div className="max-h-[min(52dvh,430px)] overflow-y-auto rounded-md border border-border bg-background p-2 sm:p-3">
      {isLoading ? (
        <div className="mb-3 flex min-h-32 items-center justify-center rounded-md border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {emptyText}
        </div>
      ) : items.length === 0 ? (
        <div className="mb-3 flex min-h-32 items-center justify-center rounded-md border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {!isLoading
          ? items.map((item) => (
            <ReferenceTile
              key={item.id}
              item={item}
              fallbackIcon={fallbackIcon}
              onSelect={onSelect}
            />
          ))
          : null}
        <CreateReferenceTile label={createAction.label} onClick={createAction.onClick} />
      </div>
    </div>
  );
}

export function ModelReferencePickerDialog({
  open,
  onOpenChange,
  products,
  personas,
  styles,
  productsLoading,
  personasLoading,
  stylesLoading,
  selectedProductIds,
  selectedPersonaIds,
  selectedStyleIds,
  fetchProducts,
  fetchPersonas,
  fetchStyles,
  fileReferenceCount,
  fileReferenceLimit,
  onImageReferenceClick,
  onProductAdd,
  onPersonaAdd,
  onStyleAdd,
}: ModelReferencePickerDialogProps) {
  const t = useTranslations('studio.promptBar');
  const tStudio = useTranslations('studio');
  const router = useRouter();
  const [referenceCategory, setReferenceCategory] = useState<ReferenceCategory>('product');
  const [referenceSearch, setReferenceSearch] = useState('');
  const loadedCategoriesRef = useRef(new Set<ReferenceCategory>());
  const inFlightCategoriesRef = useRef(new Set<ReferenceCategory>());

  const availableProducts = useMemo(
    () => products.filter((product) => !selectedProductIds.includes(product.id)),
    [products, selectedProductIds],
  );
  const availablePersonas = useMemo(
    () => personas.filter((persona) => !selectedPersonaIds.includes(persona.id)),
    [personas, selectedPersonaIds],
  );
  const availableStyles = useMemo(
    () => styles.filter((style) => !selectedStyleIds.includes(style.id)),
    [styles, selectedStyleIds],
  );
  const filteredProducts = useMemo(() => filterReferenceOptions(availableProducts, referenceSearch), [availableProducts, referenceSearch]);
  const filteredPersonas = useMemo(() => filterReferenceOptions(availablePersonas, referenceSearch), [availablePersonas, referenceSearch]);
  const filteredStyles = useMemo(() => filterReferenceOptions(availableStyles, referenceSearch), [availableStyles, referenceSearch]);

  const loadCategory = useCallback(async (category: ReferenceCategory) => {
    if (loadedCategoriesRef.current.has(category) || inFlightCategoriesRef.current.has(category)) return;

    inFlightCategoriesRef.current.add(category);
    try {
      if (category === 'product') await fetchProducts();
      else if (category === 'persona') await fetchPersonas();
      else await fetchStyles();
      loadedCategoriesRef.current.add(category);
    } finally {
      inFlightCategoriesRef.current.delete(category);
    }
  }, [fetchPersonas, fetchProducts, fetchStyles]);

  useEffect(() => {
    if (!open) return;
    void loadCategory(referenceCategory);
  }, [loadCategory, open, referenceCategory]);

  const openModelCreate = useCallback((type: ReferenceCategory) => {
    onOpenChange(false);
    router.push(`/studio/models/new?type=${type}`);
  }, [onOpenChange, router]);

  const getEmptyText = useCallback((baseCount: number, defaultText: string, isLoading: boolean) => {
    if (isLoading) return tStudio('common.loading');
    if (referenceSearch.trim()) return t('noSearchResults');
    if (baseCount > 0) return t('allReferencesSelected');
    return defaultText;
  }, [referenceSearch, t, tStudio]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) setReferenceSearch('');
  };

  const handleCategoryChange = (nextValue: string) => {
    const nextCategory = nextValue as ReferenceCategory;
    setReferenceCategory(nextCategory);
    setReferenceSearch('');
    void loadCategory(nextCategory);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-4 overflow-hidden p-4 sm:max-h-[min(86vh,760px)] sm:max-w-[760px] sm:p-6">
        <DialogHeader>
          <DialogTitle>{t('addReference')}</DialogTitle>
          <DialogDescription className="sr-only">{t('referenceCategories')}</DialogDescription>
        </DialogHeader>

        <Button
          type="button"
          variant="outline"
          className="h-12 w-full justify-start rounded-md"
          onClick={onImageReferenceClick}
        >
          <ImageIcon className="h-4 w-4" />
          {t('imageReference')}
          <span className="ml-auto text-xs text-muted-foreground">{fileReferenceCount}/{fileReferenceLimit}</span>
        </Button>

        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={referenceSearch}
            onChange={(event) => setReferenceSearch(event.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-11 w-full rounded-md border border-input bg-background pl-10 pr-10 text-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15"
          />
          {referenceSearch ? (
            <button
              type="button"
              onClick={() => setReferenceSearch('')}
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <Tabs
          value={referenceCategory}
          onValueChange={handleCategoryChange}
          className="flex min-h-0 flex-col gap-3 overflow-hidden"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="product">
              <Package2 className="h-4 w-4" />
              {t('product')}
            </TabsTrigger>
            <TabsTrigger value="persona">
              <UserRound className="h-4 w-4" />
              {t('persona')}
            </TabsTrigger>
            <TabsTrigger value="style">
              <LayoutTemplate className="h-4 w-4" />
              {t('style')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="product" className="mt-0 min-h-0 flex-none overflow-visible">
            <ReferenceOptionGrid
              items={filteredProducts}
              emptyText={getEmptyText(products.length, t('noProducts'), productsLoading)}
              createAction={{
                label: tStudio('modelLibrary.newProduct'),
                onClick: () => openModelCreate('product'),
              }}
              fallbackIcon={<Package2 className="h-4 w-4" />}
              isLoading={productsLoading}
              onSelect={(product) => {
                onProductAdd(product);
                onOpenChange(false);
              }}
            />
          </TabsContent>
          <TabsContent value="persona" className="mt-0 min-h-0 flex-none overflow-visible">
            <ReferenceOptionGrid
              items={filteredPersonas}
              emptyText={getEmptyText(personas.length, t('noPersonas'), personasLoading)}
              createAction={{
                label: tStudio('modelLibrary.newPersona'),
                onClick: () => openModelCreate('persona'),
              }}
              fallbackIcon={<UserRound className="h-4 w-4" />}
              isLoading={personasLoading}
              onSelect={(persona) => {
                onPersonaAdd(persona);
                onOpenChange(false);
              }}
            />
          </TabsContent>
          <TabsContent value="style" className="mt-0 min-h-0 flex-none overflow-visible">
            <ReferenceOptionGrid
              items={filteredStyles}
              emptyText={getEmptyText(styles.length, t('noStyles'), stylesLoading)}
              createAction={{
                label: tStudio('modelLibrary.newStyle'),
                onClick: () => openModelCreate('style'),
              }}
              fallbackIcon={<LayoutTemplate className="h-4 w-4" />}
              isLoading={stylesLoading}
              onSelect={(style) => {
                onStyleAdd(style);
                onOpenChange(false);
              }}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
