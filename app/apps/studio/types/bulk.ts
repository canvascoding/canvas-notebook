export type StudioBulkJobStatus = 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
export type StudioBulkLineItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface StudioBulkLineItemOutput {
  id: string;
  mediaUrl: string | null;
  filePath: string;
}

export interface StudioBulkLineItem {
  id: string;
  bulkJobId: string;
  productId: string | null;
  productName: string | null;
  personaId: string | null;
  studioPresetId: string | null;
  customPrompt: string | null;
  generationId: string | null;
  status: StudioBulkLineItemStatus;
  outputs?: StudioBulkLineItemOutput[];
  createdAt: string;
}

export interface StudioBulkJob {
  id: string;
  userId: string;
  name: string | null;
  studioPresetId: string | null;
  additionalPrompt: string | null;
  aspectRatio: string;
  versionsPerProduct: number;
  status: StudioBulkJobStatus;
  totalLineItems: number;
  completedLineItems: number;
  failedLineItems: number;
  lineItems: StudioBulkLineItem[];
  createdAt: string;
  updatedAt: string;
}

export interface StudioBulkCreatePayload {
  product_ids: string[];
  prompt: string;
  preset_id?: string;
  aspect_ratio?: string;
  versions_per_product?: number;
  line_item_overrides?: Array<{
    product_id: string;
    preset_id?: string;
    persona_id?: string;
    custom_prompt?: string;
  }>;
}