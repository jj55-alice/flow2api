import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const helpers = source.slice(
  source.indexOf('const imageGenerationIsActive = () =>'),
  source.indexOf('const requests = Array.isArray'),
);

const page = { buttons: [] };
const document = {
  querySelectorAll(selector) {
    assert.equal(selector, 'button');
    return page.buttons;
  },
};
const normalizedText = value => String(value || '').replace(/\s+/g, ' ').trim();
const isVisible = node => !node.hidden;
const button = ({ text = '', ariaLabel = '', title = '', icons = [], hidden = false } = {}) => ({
  hidden,
  textContent: text,
  getAttribute(name) {
    return name === 'aria-label' ? ariaLabel : name === 'title' ? title : null;
  },
  querySelectorAll(selector) {
    assert.equal(selector, 'mat-icon, i');
    return icons.map(textContent => ({ textContent }));
  },
});

const { imageGenerationIsActive, nextImageFailurePollCount } = new Function(
  'document',
  'isVisible',
  'normalizedText',
  `${helpers}; return { imageGenerationIsActive, nextImageFailurePollCount };`,
)(document, isVisible, normalizedText);

test('visible Flow stop control keeps image generation active', () => {
  page.buttons = [button({ icons: ['stop'] })];
  assert.equal(imageGenerationIsActive(), true);
});

test('visible initiating label keeps image generation active', () => {
  page.buttons = [button({ text: 'Initiating Image Generation arrow_forward_ios' })];
  assert.equal(imageGenerationIsActive(), true);
});

test('hidden controls do not keep image generation active', () => {
  page.buttons = [button({ icons: ['stop'], hidden: true })];
  assert.equal(imageGenerationIsActive(), false);
});

test('failure-like prose is ignored while Flow is still generating', () => {
  assert.equal(nextImageFailurePollCount(true, true, 4), 0);
  assert.equal(nextImageFailurePollCount(true, false, 4), 5);
  assert.equal(nextImageFailurePollCount(false, false, 4), 0);
});
