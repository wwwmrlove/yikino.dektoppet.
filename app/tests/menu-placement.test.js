'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateMenuBounds } = require('../menu-placement');
test('small work areas and negative monitors keep the whole menu reachable', () => {
  for(const area of [
    {x:0,y:0,width:900,height:540},
    {x:-1920,y:-400,width:1920,height:1080},
    {x:0,y:0,width:280,height:400},
    {x:0,y:0,width:1920,height:1080}
  ]) for(const position of [{x:200,y:100},{x:-5000,y:-5000},{x:9999,y:9999}]) {
    const b=calculateMenuBounds(position,area);
    assert.ok(b.x>=area.x && b.y>=area.y);
    assert.ok(b.x+b.width<=area.x+area.width);
    assert.ok(b.y+b.height<=area.y+area.height);
  }
  assert.deepEqual(calculateMenuBounds({x:200,y:100},{x:0,y:0,width:900,height:540}),
    {x:200,y:8,width:334,height:524});
});
