'use strict';

function calculatePetBounds(position, area, modelScale = 1) {
  const width = Math.max(1, Math.floor(Math.min(420, area.width - 24)));
  const height = Math.max(1, Math.floor(Math.min(820, area.height - 24)));
  const scale = Number.isFinite(modelScale) ? Math.min(1.35, Math.max(0.62, modelScale)) : 1;
  // A scaled-down pet sits at the bottom of a transparent window. Preserve the
  // existing allowance for dragging its empty top padding above the desktop.
  const transparentTopPadding = Math.max(0, height - height * 0.965 * scale);
  const allowedTopOverflow = Math.min(height * 0.45, transparentTopPadding + 32);
  const x = Number.isFinite(position?.x) ? position.x : area.x + area.width - width - 24;
  const y = Number.isFinite(position?.y) ? position.y : area.y + area.height - height - 12;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(y, area.y - allowedTopOverflow), area.y + area.height - height)),
    width,
    height
  };
}

module.exports = { calculatePetBounds };
