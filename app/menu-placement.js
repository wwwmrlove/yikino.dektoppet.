'use strict';

function calculateMenuBounds(position, area, preferred = { width: 334, height: 636 }) {
  const marginX = Math.min(8, Math.max(0, (area.width - 1) / 2));
  const marginY = Math.min(8, Math.max(0, (area.height - 1) / 2));
  const width = Math.max(1, Math.floor(Math.min(preferred.width, area.width - marginX * 2)));
  const height = Math.max(1, Math.floor(Math.min(preferred.height, area.height - marginY * 2)));
  return {
    x: Math.round(Math.min(Math.max(position.x, area.x + marginX), area.x + area.width - width - marginX)),
    y: Math.round(Math.min(Math.max(position.y, area.y + marginY), area.y + area.height - height - marginY)),
    width, height
  };
}

module.exports = { calculateMenuBounds };
