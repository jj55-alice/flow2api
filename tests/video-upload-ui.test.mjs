import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const body = source.split('const attachNativeUpload = async upload => {')[1]
  .split('\n                    const findGenerationApproval =')[0].trim().replace(/};$/, '}');

function uploaderFixture({ approved, earlyDialog = false }) {
  let dialogVisible = false, uploaded = false, added = false, selected = '';
  const filename = 'approved-product.jpg';
  const image = { src: 'https://flow.google.com/asb/product', closest: () => null };
  const oldOption = { textContent: 'unrelated old photo', querySelector: () => ({ src: 'old' }) };
  const option = { textContent: filename, querySelector: () => image };
  class Input {
    constructor() { this.type = 'file'; }
    click() { throw new Error('Native file chooser must be intercepted'); }
    showPicker() { this.click(); }
    set files(value) { this._files = value; }
    dispatchEvent(event) {
      if (event.type === 'change') {
        if (earlyDialog) uploaded = true;
        else dialogVisible = true;
      }
    }
  }
  const input = new Input();
  const agree = { textContent: '동의', disabled: false };
  const dialog = { textContent: '이 이미지를 사용할 권리', querySelectorAll: () => [agree] };
  const uploadButton = {};
  const search = {};
  const addButton = {};
  const picker = {
    querySelector(selector) {
      if (selector === '.sidebar-upload-btn') return uploadButton;
      if (selector === 'input[type="text"]') return search;
      if (selector === '.detail-add-to-prompt-btn') return addButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'button.asset-item[role="option"]') return uploaded ? [oldOption, option] : [oldOption];
      if (selector === 'img') return [];
      return [];
    },
  };
  const context = {
    normalizedText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    openAssetPicker: async () => picker,
    isVisible: element => element === dialog ? dialogVisible : Boolean(element),
    clickElement(element) {
      if (element === uploadButton) {
        if (earlyDialog) dialogVisible = true;
        else input.click();
      } else if (element === agree) {
        dialogVisible = false;
        if (earlyDialog) input.click();
        else uploaded = true;
      } else if (element === option) selected = filename;
      else if (element === oldOption) throw new Error('Selected an unrelated existing image');
      else if (element === addButton) { assert.equal(selected, filename); added = true; }
    },
    waitFor: async (probe, _budget, label) => {
      for (let i = 0; i < 12; i++) {
        const value = probe(); if (value) return value;
      }
      throw new Error(`Timed out: ${label}`);
    },
    pause: async () => {},
    setInputValue: (_element, value) => assert.equal(value, filename),
    HTMLInputElement: Input,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: f => this.files.push(f) }; } },
    File,
    Event,
    atob,
    document: { querySelectorAll: selector => selector.includes('dialog') ? (dialogVisible ? [dialog] : []) : [input] },
  };
  const create = new Function(...Object.keys(context), `return async upload => {${body}`);
  const upload = create(...Object.values(context));
  return { run: () => upload({ fileName: filename, mimeType: 'image/jpeg', imageBytes: 'cGhvdG8=', rightsConfirmed: approved }), added: () => added };
}

test('consent after file selection still uploads and attaches only the named product', async () => {
  const fixture = uploaderFixture({ approved: true });
  await fixture.run(); assert.equal(fixture.added(), true);
});
test('consent before file selection keeps the native chooser intercepted', async () => {
  const fixture = uploaderFixture({ approved: true, earlyDialog: true });
  await fixture.run(); assert.equal(fixture.added(), true);
});
test('an unapproved photo cannot be accepted through the later consent dialog', async () => {
  const fixture = uploaderFixture({ approved: false });
  await assert.rejects(fixture.run(), /rights confirmation is required/);
  assert.equal(fixture.added(), false);
});

test('an uploaded product can be attached when Flow exposes the add button without a duplicate preview image', async () => {
  const fixture = uploaderFixture({ approved: true });
  await fixture.run();
  assert.equal(fixture.added(), true);
});
