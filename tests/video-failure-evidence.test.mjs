import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('const readVideoFailures = () =>'), source.indexOf('const countFailureSignals = () =>'));
const page = { cards: [], reports: [] };
const document = { querySelectorAll(selector) {
  if (selector === 'flow-error-tile') return page.cards;
  if (selector === 'flow-a2ui-text') return page.reports;
  throw new Error(`Unexpected broad page read: ${selector}`);
} };
const { readVideoFailures, newVideoFailure } = new Function('document', 'isVisible', 'normalizedText', `${helpers};return {readVideoFailures,newVideoFailure}`)(document, node => !node.hidden, value => String(value || '').replace(/\s+/g, ' ').trim());
const node = text => ({ innerText: text });
function reset(cards = [], reports = []) { page.cards = cards.map(node); page.reports = reports.map(node); return readVideoFailures(); }

test('old safety-filter discussion cannot turn a new audio error into policy rejection', () => {
  const before = reset([], ['The previous video was flagged by our safety filters.']);
  page.cards.push(node('실패 오디오를 생성할 수 없습니다. 이 생성에 대한 요금이 청구되지 않았습니다.'));
  const result = newVideoFailure(before, readVideoFailures());
  assert.equal(result.code, 'flow_video_audio_failed');
  assert.equal(result.source, 'flow_error_tile');
  assert.match(result.upstream_message, /오디오를 생성할 수 없습니다/);
});
test('an agent claim is preserved as unverified, never as an upstream policy decision', () => {
  const before = reset();
  page.reports.push(node('The previous video was flagged by our safety filters.'));
  assert.equal(newVideoFailure(before, readVideoFailures()).code, 'flow_video_agent_reported_failure');
});
test('old error cards and re-created DOM nodes do not trigger a new failure', () => {
  const before = reset(['오디오를 생성할 수 없습니다.'], ['The previous video was flagged by our safety filters.']);
  reset(['오디오를 생성할 수 없습니다.'], ['The previous video was flagged by our safety filters.']);
  assert.equal(newVideoFailure(before, readVideoFailures()), null);
});
test('explicit policy text on a new error card remains a terminal policy rejection', () => {
  const before = reset(); page.cards.push(node('Generation blocked by safety filters.'));
  assert.equal(newVideoFailure(before, readVideoFailures()).code, 'flow_video_policy_rejected');
});
test('generic card failures keep their cause unknown despite policy claims in chat', () => {
  const before = reset(); page.cards.push(node('실패 에이전트가 실패했습니다. 다시 시도해 주세요.'));
  page.reports.push(node('The previous video was flagged by our safety filters.'));
  const result = newVideoFailure(before, readVideoFailures());
  assert.equal(result.code, 'flow_video_generation_failed');
  assert.equal(result.source, 'flow_error_tile');
});
test('ordinary agent discussion of filters and hidden error history are not new failures', () => {
  const before = reset(); page.reports.push(node('These settings help avoid safety filters.'));
  page.cards.push({ ...node('오디오를 생성할 수 없습니다.'), hidden: true });
  assert.equal(newVideoFailure(before, readVideoFailures()), null);
});
