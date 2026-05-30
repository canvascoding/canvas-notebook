import type { StudioGeneratePayload } from '../types/generation';
import type { StudioGenerationState } from '@/app/store/studio-generation-store';
import { toMediaUrl } from '@/app/lib/utils/media-url';

type StudioGenerateInput = Pick<
  StudioGenerationState,
  | 'rawPrompt'
  | 'mode'
  | 'productRefs'
  | 'personaRefs'
  | 'styleRefs'
  | 'presetRef'
  | 'aspectRatio'
  | 'count'
  | 'provider'
  | 'model'
  | 'quality'
  | 'outputFormat'
  | 'background'
  | 'imageSize'
  | 'fileRefs'
  | 'videoReferenceRefs'
  | 'audioReferenceRefs'
  | 'videoExtendSourceRef'
  | 'videoResolution'
  | 'videoDuration'
  | 'startFramePath'
  | 'endFramePath'
  | 'isLooping'
  | 'videoGenerateAudio'
  | 'videoWebSearch'
  | 'videoNsfwChecker'
>;

function getReferenceRequestValue(ref: { id: string }) {
  if (ref.id.startsWith('/api/media/') || ref.id.startsWith('/api/studio/media/') || ref.id.startsWith('/api/studio/references/')) return ref.id;
  if (/^https?:\/\//i.test(ref.id)) return ref.id;
  return toMediaUrl(ref.id);
}

export function buildStudioGeneratePayload(input: StudioGenerateInput): StudioGeneratePayload {
  const fileUrls = input.fileRefs.map(getReferenceRequestValue).slice(0, input.mode === 'sound' ? 10 : undefined);
  const videoReferenceUrls = input.videoReferenceRefs.map(getReferenceRequestValue).slice(0, 3);
  const audioReferenceUrls = input.audioReferenceRefs.map(getReferenceRequestValue).slice(0, 3);
  const videoExtendSourcePath = input.videoExtendSourceRef
    ? getReferenceRequestValue(input.videoExtendSourceRef)
    : undefined;
  const isVeoExtend = input.mode === 'video' && input.provider === 'veo' && Boolean(videoExtendSourcePath);
  const hasVideoImageInput = input.mode === 'video' && !input.videoExtendSourceRef && (
    Boolean(input.startFramePath) ||
    input.productRefs.length > 0 ||
    input.personaRefs.length > 0 ||
    input.styleRefs.length > 0 ||
    input.fileRefs.length > 0 ||
    input.videoReferenceRefs.length > 0 ||
    input.audioReferenceRefs.length > 0
  );
  const personGeneration = hasVideoImageInput ? 'allow_adult' as const : 'allow_all' as const;

  return {
    prompt: input.rawPrompt.trim(),
    mode: input.mode,
    product_ids: input.productRefs.map((product) => product.id),
    persona_ids: input.personaRefs.map((persona) => persona.id),
    style_ids: input.styleRefs.map((style) => style.id),
    preset_id: input.mode === 'sound' ? undefined : input.presetRef?.id,
    aspect_ratio: input.aspectRatio,
    count: input.mode === 'video' || input.mode === 'sound' ? 1 : input.count,
    provider: input.provider,
    model: input.model,
    quality: input.provider === 'openai' ? input.quality : undefined,
    output_format: input.mode === 'sound'
      ? (input.outputFormat === 'wav' ? 'wav' : 'mp3')
      : input.provider === 'openai'
        ? (['png', 'jpeg', 'webp'].includes(input.outputFormat) ? input.outputFormat as 'png' | 'jpeg' | 'webp' : 'png')
        : undefined,
    background: input.provider === 'openai' ? input.background : undefined,
    image_size: input.mode === 'image' && input.provider === 'gemini' && input.model !== 'gemini-2.5-flash-image' ? input.imageSize : undefined,
    extra_reference_urls: isVeoExtend ? undefined : fileUrls,
    video_reference_urls: !isVeoExtend && input.mode === 'video' && input.provider === 'bytedance' ? videoReferenceUrls : undefined,
    audio_reference_urls: !isVeoExtend && input.mode === 'video' && input.provider === 'bytedance' ? audioReferenceUrls : undefined,
    video_extend_source_path: isVeoExtend ? videoExtendSourcePath : undefined,
    video_resolution: input.mode === 'video' ? (isVeoExtend ? '720p' : input.videoResolution) : undefined,
    video_duration: input.mode === 'video' ? (isVeoExtend ? 8 : input.videoDuration) : undefined,
    start_frame_path: input.mode === 'video' && !isVeoExtend ? input.startFramePath : undefined,
    end_frame_path: input.mode === 'video' && !isVeoExtend ? input.endFramePath : undefined,
    is_looping: input.mode === 'video' && !isVeoExtend ? input.isLooping : undefined,
    person_generation: input.mode === 'video' ? personGeneration : undefined,
    video_generate_audio: input.mode === 'video' && input.provider === 'bytedance' ? input.videoGenerateAudio : undefined,
    video_web_search: input.mode === 'video' && input.provider === 'bytedance' ? input.videoWebSearch : undefined,
    video_nsfw_checker: input.mode === 'video' && input.provider === 'bytedance' ? input.videoNsfwChecker : undefined,
  };
}
