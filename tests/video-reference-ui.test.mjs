import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(process.env.FLOW_SOURCE_FILE || new URL('../extension/background.js', import.meta.url), 'utf8');
const firstUpload = source.indexOf('for (const upload of inputUploads) {');
const directive = source.indexOf('const directive = [');
const body = source.slice(Math.min(firstUpload, directive), source.indexOf('clickElement(submitButton);', directive));

test('the actual composer preparation retains the uploaded reference until submit', async () => {
  const composer = { nodes: ['old draft'], focus() {} };
  const submit = { disabled: false, getAttribute: () => 'false' };
  const selection = { removeAllRanges() {}, addRange() {} };
  const input = { fileName: 'approved-reference.jpg' };
  const context = {
    document: {
      querySelectorAll: selector => selector === '[contenteditable="true"]' ? [composer] : [],
      createRange: () => ({ selectNodeContents() {} }),
      execCommand(command, _ui, value) {
        if (command === 'delete') composer.nodes = [];
        if (command === 'insertText') composer.nodes.push(value);
        return true;
      },
    },
    getSelection: () => selection,
    inputUploads: [input], inputFileNames: [],
    attachNativeUpload: async upload => { composer.nodes.push({ reference: upload.fileName }); },
    isVideo: true, requestedInputs: [input], prompt: 'Show adult hands using this product.',
    requestedAspect: '9:16', requestedModel: 'Veo 3.1 Fast',
    isVisible: () => true, normalizedText: value => value, reportProgress() {},
    waitFor: async probe => { const result = probe(); assert.ok(result); return result; },
    pause: async () => {}, currentMediaAssets: () => new Map(),
    readVideoFailures: () => ({ cards: new Map(), reports: new Map() }),
    findButtonByIcon: () => submit,
  };
  const run = new Function(...Object.keys(context), `return (async()=>{${body}})();`);
  await run(...Object.values(context));
  assert.equal(composer.nodes.length, 2);
  assert.match(composer.nodes[0], /actual first frame and image input/);
  assert.deepEqual(composer.nodes[1], { reference: input.fileName });
  assert.ok(!composer.nodes.includes('old draft'));
});
