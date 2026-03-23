import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { auth } from '@/app/lib/auth';

// Configuration for image processing
const MAX_IMAGE_DIMENSION = 1024; // Max width/height in pixels
const MAX_FILE_SIZE_MB = 5; // Max file size in MB before processing
const OUTPUT_QUALITY = 85; // WebP quality (0-100)

interface ProcessedImageResult {
  buffer: Buffer;
  originalSize: number;
  processedSize: number;
  wasResized: boolean;
  wasCompressed: boolean;
  width: number;
  height: number;
}

async function processImage(buffer: Buffer, mimeType: string): Promise<ProcessedImageResult> {
  const originalSize = buffer.length;
  const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
  
  // Load image with sharp
  let image = sharp(buffer);
  const metadata = await image.metadata();
  
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  
  // Check if resizing is needed
  const needsResize = originalWidth > MAX_IMAGE_DIMENSION || originalHeight > MAX_IMAGE_DIMENSION;
  
  // Check if compression is needed (file too large or not webp)
  const needsCompression = originalSize > maxBytes || !mimeType.includes('webp');
  
  if (needsResize) {
    // Resize to fit within MAX_IMAGE_DIMENSION while maintaining aspect ratio
    image = image.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  
  // Convert to WebP with quality setting
  image = image.webp({ 
    quality: OUTPUT_QUALITY,
    effort: 4, // Balance between speed and compression (0-6)
  });
  
  const processedBuffer = await image.toBuffer();
  const processedSize = processedBuffer.length;
  
  // Get final dimensions
  const processedImage = sharp(processedBuffer);
  const processedMetadata = await processedImage.metadata();
  
  return {
    buffer: processedBuffer,
    originalSize,
    processedSize,
    wasResized: needsResize,
    wasCompressed: needsCompression || processedSize < originalSize,
    width: processedMetadata.width || originalWidth,
    height: processedMetadata.height || originalHeight,
  };
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return NextResponse.json({ success: false, error: 'Invalid file type. Supported: PNG, JPEG, WebP, GIF' }, { status: 400 });
    }

    // Read file buffer
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    
    // Process the image (resize and compress)
    const processed = await processImage(fileBuffer, file.type);
    
    // Create temp directory if it doesn't exist
    const DATA = process.env.DATA || path.join(process.cwd(), 'data');
    const tempDir = path.join(DATA, 'temp', 'screenshots');
    await fs.mkdir(tempDir, { recursive: true });

    // Use WebP extension for processed image
    const baseName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/\.[^.]+$/, '');
    const fileName = `${Date.now()}_${baseName}.webp`;
    const filePath = path.join(tempDir, fileName);
    
    // Write processed image
    await fs.writeFile(filePath, processed.buffer);

    // Log processing info
    const sizeReduction = ((processed.originalSize - processed.processedSize) / processed.originalSize * 100).toFixed(1);
    console.log(`[Image Upload] Processed ${file.name}: ${processed.originalSize} → ${processed.processedSize} bytes (${sizeReduction}% reduction), ${processed.width}x${processed.height}`);

    // Return the ABSOLUTE path for the AI to use
    return NextResponse.json({
      success: true,
      path: filePath,
      name: file.name,
      type: 'image/webp',
      processed: {
        originalSize: processed.originalSize,
        processedSize: processed.processedSize,
        wasResized: processed.wasResized,
        wasCompressed: processed.wasCompressed,
        dimensions: {
          width: processed.width,
          height: processed.height,
        },
        sizeReductionPercent: parseFloat(sizeReduction),
      },
    });
  } catch (error) {
    console.error('[API] Screenshot upload error:', error);
    return NextResponse.json({ 
      success: false, 
      error: 'Failed to process image. Please try a different image.' 
    }, { status: 500 });
  }
}
