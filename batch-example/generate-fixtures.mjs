import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
await mkdir('examples/input',{recursive:true});
for (const [i,colour] of ['#956f48','#73849a'].entries()) {
  const gem = i ? '<path d="M200 52l32 35-32 29-32-29z"/>' : '<circle cx="200" cy="86" r="32"/>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#faf8f4"/><circle cx="200" cy="212" r="113" fill="none" stroke="'+colour+'" stroke-width="15"/><g fill="'+colour+'">'+gem+'</g></svg>';
  await sharp(Buffer.from(svg)).png().toFile('examples/input/RING-0'+(i+1)+'.png');
}
