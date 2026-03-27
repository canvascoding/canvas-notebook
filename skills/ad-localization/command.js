#!/usr/bin/env node

const { runLocalSkill } = require('../_shared/local-skill-runner');

let referenceImagePath = '';
const targetMarkets = [];
let aspectRatio = '16:9';
let model = 'gemini-3.1-flash-image-preview';
let customInstructions = '';

const args = process.argv.slice(2);
for (let index = 0; index < args.length; ) {
  const current = args[index];
  switch (current) {
    case '--ref':
    case '-r':
      referenceImagePath = args[index + 1] || '';
      index += 2;
      break;
    case '--market':
    case '-t':
      if (args[index + 1]) {
        targetMarkets.push(args[index + 1]);
      }
      index += 2;
      break;
    case '--aspect-ratio':
    case '-a':
      aspectRatio = args[index + 1] || aspectRatio;
      index += 2;
      break;
    case '--model':
    case '-m':
      model = args[index + 1] || model;
      index += 2;
      break;
    case '--instructions':
    case '-i':
      customInstructions = args[index + 1] || '';
      index += 2;
      break;
    default:
      console.error(`Unknown option: ${current}`);
      process.exit(1);
  }
}

runLocalSkill('ad-localization', {
  referenceImagePath,
  targetMarkets,
  aspectRatio,
  model,
  customInstructions,
});
