import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const findGenerationApproval = () =>'), source.indexOf('const directive = ['));
function choice(text, attributes = {}) {
  return { textContent: text, hidden: false, ...attributes,
    getAttribute(name) { return attributes[name] ?? null; },
    cloneNode() { return { textContent: text, querySelectorAll: () => [] }; },
  };
}
function find(items, video = true) {
  return new Function('document', 'isVisible', 'normalizedText', 'isVideo', `${helper}; return findGenerationApproval();`)(
    { querySelectorAll: () => items }, e => Boolean(e) && !e.hidden, v => String(v || '').replace(/\s+/g, ' ').trim(), video,
  );
}
test('video permission selects the single radio approval, never always-approve or deny', () => {
  const one = choice('승인', { role: 'radio' });
  assert.equal(find([choice('항상 승인', { role: 'radio' }), choice('거부', { role: 'radio' }), one]), one);
});
test('native radios with hidden inputs use their visible label', () => {
  const label = choice('승인');
  assert.equal(find([choice('', { hidden: true, labels: [label] })]), label);
});
test('checked, disabled and hidden old approval controls cannot be selected again', () => {
  assert.equal(find([choice('승인', { checked: true }), choice('승인', { disabled: true }), choice('승인', { 'aria-disabled': 'true' }), choice('승인', { 'aria-checked': 'true' }), choice('승인', { hidden: true })]), null);
});
test('video approval ignores generic create/confirm buttons and retains accessible labels', () => {
  const one = choice('check 승인', { 'aria-label': '승인' });
  assert.equal(find([choice('확인'), choice('Create'), one]), one);
  assert.equal(find([choice('Always approve')]), null);
  const imageCreate = choice('Create');
  assert.equal(find([imageCreate], false), imageCreate);
});
