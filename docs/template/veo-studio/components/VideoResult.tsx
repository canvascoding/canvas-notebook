
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import React, {useState, useRef} from 'react';
import {AspectRatio} from '../types';
import {ArrowPathIcon, DownloadIcon, SparklesIcon, FileImageIcon, PlusIcon} from './icons';
// @ts-ignore
import gifshot from 'gifshot';

interface VideoResultProps {
  videoUrl: string;
  onRetry: () => void;
  onNewVideo: () => void;
  onExtend: () => void;
  canExtend: boolean;
  aspectRatio: AspectRatio;
}

const VideoResult: React.FC<VideoResultProps> = ({
  videoUrl,
  onRetry,
  onNewVideo,
  onExtend,
  canExtend,
  aspectRatio,
}) => {
  const isPortrait = aspectRatio === AspectRatio.PORTRAIT;
  const [isConvertingGif, setIsConvertingGif] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleDownloadGif = async (frames: number) => {
    if (!videoUrl) return;
    
    setIsConvertingGif(true);
    
    try {
      // Create an off-screen video element to capture frames
      const video = document.createElement('video');
      video.src = videoUrl;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";

      // Wait for metadata to ensure we have duration
      await new Promise((resolve) => {
        if (video.readyState >= 1) {
          resolve(null);
        } else {
          video.onloadedmetadata = () => resolve(null);
        }
      });

      const duration = video.duration;
      const width = isPortrait ? 360 : 640;
      const height = isPortrait ? 640 : 360;
      
      // Calculate time step to cover the full video duration in 'frames' count
      const step = duration / frames;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const images: string[] = [];

      // Extract frames
      for (let i = 0; i < frames; i++) {
        const time = i * step;
        
        // Seek only if necessary (skip for first frame if at 0)
        if (time > 0) {
          video.currentTime = time;
          await new Promise((resolve) => {
             const onSeeked = () => {
               video.removeEventListener('seeked', onSeeked);
               resolve(null);
             };
             video.addEventListener('seeked', onSeeked);
          });
        }
        
        if (ctx) {
          ctx.drawImage(video, 0, 0, width, height);
          images.push(canvas.toDataURL('image/jpeg', 0.8));
        }
      }

      // Generate GIF from extracted images
      gifshot.createGIF({
        images: images,
        interval: 0.1, // 10fps playback
        gifWidth: width,
        gifHeight: height,
        numFrames: frames,
        sampleInterval: 10,
      }, (obj: any) => {
        if (!obj.error) {
          const link = document.createElement('a');
          link.href = obj.image;
          link.download = `veo-studio-creation-${(frames/10).toFixed(1)}s.gif`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } else {
          console.error('GIF generation failed:', obj.error);
          alert('Failed to generate GIF. Try again.');
        }
        setIsConvertingGif(false);
      });

    } catch (error) {
      console.error('Error preparing GIF:', error);
      setIsConvertingGif(false);
      alert('An error occurred while preparing the GIF.');
    }
  };

  const getDurationLabel = (divisor: number) => {
    if (!videoDuration) return divisor === 1 ? '8s' : divisor === 2 ? '4s' : '2s';
    return `${Math.round(videoDuration / divisor)}s`;
  };

  // Base frames on 10fps
  const getFrames = (divisor: number) => {
    const duration = videoDuration || 8; // fallback
    return Math.floor((duration / divisor) * 10);
  }

  return (
    <div className="w-full relative flex flex-col items-center gap-8 p-12 bg-gray-800/50 rounded-lg border border-gray-700 shadow-2xl overflow-visible">
      {/* New Video Button moved to top-left corner of the card */}
      <button
        onClick={onNewVideo}
        className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-purple-600/80 hover:bg-purple-600 text-white text-xs font-semibold rounded-lg transition-all active:scale-95 shadow-lg shadow-purple-900/20 z-10"
      >
        <PlusIcon className="w-4 h-4" />
        New Video
      </button>

      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-200">
          Your Creation is Ready!
        </h2>
        <p className="text-sm text-gray-400 mt-1 italic">
          High-fidelity cinematic output generated with Veo 3.1
        </p>
      </div>

      <div 
        className={`w-full ${
          isPortrait ? 'max-w-xs aspect-[9/16]' : 'max-w-2xl aspect-video'
        } rounded-lg overflow-hidden bg-black shadow-[0_0_50px_rgba(79,70,229,0.2)] border border-indigo-500/30 transition-all duration-500`}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          autoPlay
          loop
          className="w-full h-full object-contain"
          onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
        />
      </div>

      <div className="flex flex-wrap justify-center gap-4">
        <button
          onClick={onRetry}
          className="flex items-center gap-2 px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg transition-all active:scale-95"
          title="Regenerate with same parameters">
          <ArrowPathIcon className="w-5 h-5" />
          Retry
        </button>
        
        <a
          href={videoUrl}
          download="veo-studio-creation.mp4"
          className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg transition-all active:scale-95 shadow-lg shadow-emerald-900/20">
          <DownloadIcon className="w-5 h-5" />
          Download MP4
        </a>

        {/* GIF Download Dropdown with hover bridge fix */}
        <div className="relative group">
          <button
            disabled={isConvertingGif}
            onClick={() => handleDownloadGif(getFrames(1))}
            className={`flex items-center gap-2 px-6 py-3 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg transition-all active:scale-95 shadow-lg shadow-amber-900/20 disabled:opacity-50 disabled:cursor-wait`}
          >
            {isConvertingGif ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            ) : (
              <FileImageIcon className="w-5 h-5" />
            )}
            {isConvertingGif ? 'Converting...' : 'Download GIF'}
          </button>
          
          {!isConvertingGif && (
            <div className="absolute bottom-full left-0 mb-2 w-full bg-gray-800 border border-gray-700 rounded-xl shadow-2xl overflow-visible opacity-0 translate-y-2 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto transition-all duration-200 z-30
            after:content-[''] after:absolute after:top-full after:left-0 after:w-full after:h-4">
              <div className="overflow-hidden rounded-xl bg-gray-800">
                <div className="p-3 text-[10px] text-gray-400 uppercase tracking-widest border-b border-gray-700 text-center font-bold">
                  Select GIF Duration
                </div>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDownloadGif(getFrames(4)); }}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-amber-600/50 transition-colors flex justify-between items-center group/item"
                >
                  <span>{getDurationLabel(4)}</span>
                  <span className="text-[10px] text-gray-500 group-hover/item:text-white">4x Speed</span>
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDownloadGif(getFrames(2)); }}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-amber-600/50 transition-colors flex justify-between items-center group/item"
                >
                  <span>{getDurationLabel(2)}</span>
                  <span className="text-[10px] text-gray-500 group-hover/item:text-white">2x Speed</span>
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDownloadGif(getFrames(1)); }}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-amber-600/50 transition-colors flex justify-between items-center group/item"
                >
                  <span>{getDurationLabel(1)}</span>
                  <span className="text-[10px] text-gray-500 group-hover/item:text-white">Normal</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {canExtend ? (
          <button
            onClick={onExtend}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-900/20"
            title="Extend this video by 7 seconds">
            <SparklesIcon className="w-5 h-5" />
            Extend
          </button>
        ) : (
          <button
            disabled
            className="flex items-center gap-2 px-6 py-3 bg-gray-700/50 text-gray-500 font-semibold rounded-lg cursor-not-allowed opacity-60 border border-gray-700"
            title="1080p/4k videos can't be extended">
            <SparklesIcon className="w-5 h-5" />
            Extend
          </button>
        )}
      </div>
    </div>
  );
};

export default VideoResult;
