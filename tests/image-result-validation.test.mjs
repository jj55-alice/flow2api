import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function sameFlowImage('), source.indexOf('async function embedCurrentFlowImages('));
const { sameFlowImage, createFlowResultValidator } = new Function(
  'isCurrentFlowImageUrl', `${helpers}; return { sameFlowImage, createFlowResultValidator };`,
)(url => /^https:\/\/flow-content\.google\/image\//.test(url));
const fingerprint = value => ({ aspect: 0.75, pixels: Uint8ClampedArray.from({length: 64 * 64 * 4}, (_, i) => i % 4 === 3 ? 255 : value) });
const reference = fingerprint(100);
const recompressed = fingerprint(101);
const newScene = fingerprint(130);
const asset = id => ({ identity: id, url: `https://flow-content.google/image/${id}` });

test('recompressed reference pixels are rejected while a new scene is distinct', () => {
  assert(sameFlowImage(reference, recompressed));
  assert(!sameFlowImage(reference, newScene));
  assert(!sameFlowImage(reference, {...reference, aspect: 1.5}));
});

test('the validator skips the uploaded cover and retains the generated body payload', async () => {
  const calls = [];
  const validator = createFlowResultValidator([{ imageBytes: 'cover', mimeType: 'image/jpeg' }],
    async url => { calls.push(url); return { encodedImage: url.endsWith('upload') ? 'copy' : 'body', mimeType: 'image/jpeg' }; },
    async encoded => ({ cover: reference, copy: recompressed, body: newScene })[encoded],
  );
  assert.equal((await validator.check(asset('upload'))).status, 'reference');
  assert.equal((await validator.check(asset('body'))).status, 'accepted');
  assert.equal((await validator.check(asset('upload'))).status, 'reference');
  assert.equal(calls.length, 2);
  assert.equal(validator.accepted.get(asset('body').url).encodedImage, 'body');
  assert(!validator.accepted.has(asset('upload').url));
});

test('failed pixel verification or an unsupported destination never succeeds', async () => {
  let calls = 0;
  const validator = createFlowResultValidator([], async () => { calls++; throw new Error('download failed'); }, async () => newScene);
  assert.equal((await validator.check({identity:'x',url:'https://untrusted.test/image'})).status, 'error');
  assert.equal(calls, 0);
  assert.equal((await validator.check(asset('body'))).status, 'error');
  assert.equal(validator.accepted.size, 0);
});

const loop = source.slice(source.indexOf('const uiTimeoutMs ='), source.indexOf('\n                };\n\n                const parsedRequestUrl'));
async function runLoop({wrongRequest = false, error = false, neverChecked = false} = {}) {
  let time = 0;
  let sawReference = false;
  let polls = 0;
  const window = {};
  const baselineIds = new Set();
  const context = {
    isVideo:false, timeoutMs:180000, Date:{now:()=>time}, window, requestId:'request-1',
    pause:async () => {
      time += 1000; polls++;
      const candidate = window.__FLOW2API_IMAGE_CANDIDATES__?.assets[0];
      if (candidate && !neverChecked) {
        sawReference ||= candidate.identity === 'upload';
        window.__FLOW2API_IMAGE_VERDICT__ = {
          request_id:wrongRequest ? 'unrelated' : 'request-1', ...candidate,
          status:error ? 'error' : candidate.identity === 'upload' ? 'reference' : 'accepted',
        };
      }
    },
    currentMediaAssets:()=>new Map([['upload',asset('upload')], ...(polls >= 8 ? [['body',asset('body')]] : [])]),
    imageGenerationIsActive:()=>false,
    reportProgress(){}, findGenerationApproval:()=>null, baselineIds, baselineFailureCount:0,
    countFailureSignals:()=>0, nextImageFailurePollCount:()=>0,
    prompt:'body narration and speech', imageRequest:{}, browserFingerprint:()=>({}),
  };
  const run = new Function(...Object.keys(context), `return (async()=>{${loop}})();`);
  const result = await run(...Object.values(context));
  return {result:JSON.parse(result.response_text), sawReference, baselineIds};
}

test('the real page loop waits past the uploaded reference and returns only the validated body', async () => {
  const {result,sawReference,baselineIds} = await runLoop();
  assert(sawReference);
  assert(baselineIds.has('upload'));
  assert.equal(result.media[0].image.generatedImage.fifeUrl, asset('body').url);
});

test('the page rejects failed verification and never trusts stale or absent approvals', async () => {
  await assert.rejects(runLoop({error:true}), /validation failed/);
  await assert.rejects(runLoop({wrongRequest:true}), /Timed out/);
  await assert.rejects(runLoop({neverChecked:true}), /Timed out/);
});
