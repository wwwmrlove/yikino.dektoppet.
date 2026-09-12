'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePetBounds } = require('../pet-placement');

test('default placement fits small and negative-coordinate work areas for every supported user scale', () => {
  for (const area of [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 900, height: 540 },
    { x: -900, y: -540, width: 900, height: 540 },
    { x: 0, y: 0, width: 280, height: 400 }
  ]) for (const scale of [0.62, 0.8, 1, 1.35]) {
    const bounds = calculatePetBounds(null, area, scale);
    assert.ok(bounds.x >= area.x);
    assert.ok(bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
    assert.equal(bounds.width, Math.min(420, area.width - 24));
    assert.equal(bounds.height, Math.min(820, area.height - 24));
  }
});

test('clamping preserves reachable model bottom and allows only the documented transparent top padding', () => {
  const area = { x: -900, y: -540, width: 900, height: 540 };
  for (const scale of [0.62, 1, 1.35]) for (const point of [{ x: -9999, y: -9999 }, { x: 9999, y: 9999 }]) {
    const bounds = calculatePetBounds(point, area, scale);
    const allowed = Math.min(bounds.height * 0.45, Math.max(0, bounds.height * (1 - 0.965 * scale)) + 32);
    assert.ok(bounds.y >= Math.round(area.y - allowed));
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
  }
});
