import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('const pollProgress = async () =>');
const body = source.slice(start, source.indexOf('progressMonitor = setInterval', start));

test('a slow image validator cannot block progress heartbeats or start duplicate validation', async () => {
  let release;
  let checks = 0;
  const verdictReady = new Promise(resolve => {release=resolve;});
  const events = [];
  const writes = [];
  const imageValidator = {check:async candidate => {checks++; await verdictReady; return {...candidate,status:'accepted'};}};
  const chrome = {scripting:{executeScript:async request => {
    if (request.args.length === 2) {writes.push(request.args[1]); return [];}
    return [{result:{phase:'generating',updated_at:Date.now()+events.length,imageCandidates:[{identity:'body',url:'https://flow.google.com/asb/body'}]}}];
  }}};
  const create = new Function('chrome','imageValidator','sendFlowSubmitProgress', `
    let newTabId=1, progressPollRunning=false, imageValidationRunning=false, imageValidationClosed=false, lastProgressUpdatedAt=0;
    const data={req_id:'request-1'}, socket={};
    ${body}
    return {pollProgress, close:()=>{imageValidationClosed=true;}, running:()=>imageValidationRunning};
  `);
  const runner = create(chrome,imageValidator,(_data,_socket,phase)=>events.push(phase));
  await Promise.race([runner.pollProgress(), new Promise((_,reject)=>setTimeout(()=>reject(new Error('Heartbeat waited for image validation')),100))]);
  await runner.pollProgress();
  assert.equal(events.length,2);
  assert.equal(checks,1);
  assert(runner.running());
  runner.close();
  release();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(writes.length,0,'a closed request cannot publish a late verdict');
  assert(!runner.running());
});
