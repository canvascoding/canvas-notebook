import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';

const STARTING_POINTS = [
  {
    id: 'sp-fashion-editorial',
    title: 'Fashion Editorial',
    description: 'High-end fashion photography with dramatic lighting and editorial composition.',
    category: 'Fashion',
    prompt: 'High-end fashion editorial photograph, model wearing designer outfit, dramatic studio lighting, vogue-style composition, sharp detail, premium aesthetic',
    presetId: null,
  },
  {
    id: 'sp-product-catalog',
    title: 'Product Catalog',
    description: 'Clean catalog-style product visual with sharp lighting and premium detail.',
    category: 'Product',
    prompt: 'Professional product photography, clean white background, studio lighting, sharp focus, catalog-style composition, premium product detail',
    presetId: null,
  },
  {
    id: 'sp-lifestyle-campaign',
    title: 'Lifestyle Campaign',
    description: 'Warm editorial scene with people, context, and brand atmosphere.',
    category: 'Lifestyle',
    prompt: 'Warm lifestyle editorial photograph, people in natural setting, brand atmosphere, candid moment, golden hour lighting, authentic scene',
    presetId: null,
  },
  {
    id: 'sp-beauty-closeup',
    title: 'Beauty Close-up',
    description: 'Skincare or cosmetics concept with luminous surfaces and elegant gradients.',
    category: 'Beauty',
    prompt: 'Beauty close-up photograph, skincare product, luminous surfaces, elegant gradients, soft lighting, dewy skin texture, premium cosmetics aesthetic',
    presetId: null,
  },
  {
    id: 'sp-food-styling',
    title: 'Food Styling',
    description: 'Appetizing food photography with professional styling and natural light.',
    category: 'Food',
    prompt: 'Professional food photography, styled plating, natural daylight, appetizing composition, shallow depth of field, editorial food styling',
    presetId: null,
  },
  {
    id: 'sp-architecture',
    title: 'Architecture & Interior',
    description: 'Clean architectural photography with geometric composition and ambient light.',
    category: 'Architecture',
    prompt: 'Architectural photography, clean geometric composition, ambient natural light, interior design showcase, minimal aesthetic, wide-angle perspective',
    presetId: null,
  },
  {
    id: 'sp-video-cinematic',
    title: 'Cinematic Video Clip',
    description: 'Start from a still or text prompt and evolve it into a cinematic clip.',
    category: 'Video',
    prompt: 'Cinematic video scene, slow camera movement, atmospheric lighting, film grain, dramatic mood, professional cinematography',
    presetId: null,
  },
  {
    id: 'sp-abstract-texture',
    title: 'Abstract & Texture',
    description: 'Abstract visual with rich textures, patterns, and artistic expression.',
    category: 'Abstract',
    prompt: 'Abstract visual art, rich textures and patterns, artistic expression, mixed media aesthetic, experimental composition, creative color palette',
    presetId: null,
  },
];

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ success: true, startingPoints: STARTING_POINTS });
}