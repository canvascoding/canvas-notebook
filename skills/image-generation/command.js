#!/usr/bin/env node

const { runLocalSkill } = require('../_shared/local-skill-runner');

let prompt = '';
let model = 'gemini-3.1-flash-image-preview';
let aspectRatio = '1:1';
let count = 1;
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
    case '--aspect-ratio':
    case '-a':
      aspectRatio = args[index + 1] || aspectRatio;
      index += 2;
      break;
    case '--count':
    case '-n':
      count = Number.parseInt(args[index + 1] || '1', 10);
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

runLocalSkill('image-generation', {
  prompt,
  model,
  aspectRatio,
  imageCount: count,
  referenceImagePaths,
});
