#!/usr/bin/env node

const { runLocalSkill } = require('../_shared/local-skill-runner');

let prompt = '';
let model = 'veo-3.1-fast-generate-preview';
let mode = 'text_to_video';
let aspectRatio = '16:9';
let resolution = '720p';
let startFramePath = null;
let endFramePath = null;
let inputVideoPath = null;
const referenceImagePaths = [];

const args = process.argv.slice(2);
for (let index = 0; index < args.length; ) {
  const current = args[index];
  switch (current) {
    case '--prompt':
    case '-p':
      prompt = args[index + 1] || '';
      index += 2;
      break;
    case '--model':
    case '-m':
      model = args[index + 1] || model;
      index += 2;
      break;
    case '--mode':
      mode = args[index + 1] || mode;
      index += 2;
      break;
    case '--aspect-ratio':
    case '-a':
      aspectRatio = args[index + 1] || aspectRatio;
      index += 2;
      break;
    case '--resolution':
      resolution = args[index + 1] || resolution;
      index += 2;
      break;
    case '--start-frame':
      startFramePath = args[index + 1] || null;
      index += 2;
      break;
    case '--end-frame':
      endFramePath = args[index + 1] || null;
      index += 2;
      break;
    case '--input-video':
      inputVideoPath = args[index + 1] || null;
      index += 2;
      break;
    case '--ref':
    case '-r':
      if (args[index + 1]) {
        referenceImagePaths.push(args[index + 1]);
      }
      index += 2;
      break;
    default:
      console.error(`Unknown option: ${current}`);
      process.exit(1);
  }
}

runLocalSkill('video-generation', {
  prompt,
  model,
  mode,
  aspectRatio,
  resolution,
  startFramePath,
  endFramePath,
  inputVideoPath,
  referenceImagePaths,
});
