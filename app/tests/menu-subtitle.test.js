'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(file) {
  const nodes = new Map(), callbacks = {}, moves = [], timers = new Map();
  let sequence = 0;
  function element() {
    const classes = new Set();
    return { children: [], dataset: {}, events: {}, textContent: '', lastChild: {}, style: {setProperty() {}},
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
        toggle(x, force) { if(force) classes.add(x); else classes.delete(x); } },
      append(...xs) { this.children.push(...xs); }, replaceChildren(...xs) { this.children = xs; },
      addEventListener(name, fn) { this.events[name] = fn; }, querySelector() { return this.span ||= element(); },
      querySelectorAll() { return this.children.filter(x => x.open); },
      setPointerCapture() {}, hasPointerCapture() { return false; }
    };
  }
  const get = id => { if(!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const api = new Proxy({}, { get(_target, name) {
    if(name === 'getState') return () => Promise.resolve(null);
    if(name === 'moveWindow') return (...args) => moves.push(args);
    return fn => { callbacks[name] = fn; };
  } });
  const context = vm.createContext({console, document: {
    getElementById: get, querySelector: get, createElement: element, addEventListener() {}, documentElement: element()
  }, window: {petMenu: api, subtitleCloud: api, addEventListener() {},
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { fn(); }
  }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {nodes, callbacks, moves, timers, get, run: code => vm.runInContext(code, context)};
}

test('menu refresh preserves voice group nodes and expanded state', () => {
  const h = harness('pet-menu/renderer.js');
  const state = {voiceGroups: [{label:'时间',dialogues:[{id:'one',label:'早安'}]}],rendererStatus:'ready'};
  h.callbacks.onRefresh(state);
  const first = h.get('voice-groups').children[0]; first.open = true;
  h.callbacks.onRefresh({...state,weatherSummary:'已刷新'});
  assert.equal(h.get('voice-groups').children[0], first);
  h.callbacks.onRefresh({...state,voiceGroups:[{label:'时间',dialogues:[{id:'two',label:'晚安'}]}]});
  assert.equal(h.get('voice-groups').children[0].open, true);
});

test('clicking or slightly shaking menu header does not enable manual placement', () => {
  const h = harness('pet-menu/renderer.js'), events = h.get('.header').events;
  const event = {button:0, buttons:1,pointerId:1,screenX:100,screenY:100,clientX:30,clientY:20,
    target:{closest:()=>false},preventDefault(){}};
  events.pointerdown(event); events.pointermove({...event,screenX:102}); events.pointerup(event);
  assert.equal(h.moves.length, 0);
  events.pointerdown(event); events.pointermove({...event,screenX:106}); events.pointerup({...event,screenX:106});
  assert.deepEqual(h.moves, [[76,80,false],[76,80,true]]);
});

test('old subtitle delayed text switch cannot overwrite the next sentence or reappear after hide', () => {
  const h = harness('subtitle/renderer.js');
  h.callbacks.onShow({token:1,text:'这是一句需要分成两段显示的非常长的测试字幕，后半句不能出现在下一次播放的字幕中。'});
  const [id, fn] = [...h.timers][0]; h.timers.delete(id); fn();
  assert.equal(h.timers.size, 1);
  h.callbacks.onShow({token:2,text:'新台词'});
  assert.equal(h.timers.size, 0);
  assert.equal(h.get('subtitle-text').textContent, '新台词');
  h.run("replaceText('旧内容', 2)");
  h.callbacks.onHide(2);
  for(const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); }
  assert.equal(h.get('subtitle-text').textContent, '新台词');
});
