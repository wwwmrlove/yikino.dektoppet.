'use strict';

function calculateSubtitlePlacement({ anchor, workArea, subtitleWidth, subtitleHeight, overlap = 0 }) {
  const margin = 8;
  const naturalY = Math.round(anchor.y - subtitleHeight + overlap);
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - subtitleWidth - margin;
  const petCenterX = anchor.x;
  const leftTailAnchor = 0.22;
  const rightTailAnchor = 0.78;
  const preferredRightX = Math.round(petCenterX - subtitleWidth * leftTailAnchor);
  const tailDirection = preferredRightX <= maxX ? 'left' : 'right';
  const desiredX = tailDirection === 'left'
    ? preferredRightX
    : Math.round(petCenterX - subtitleWidth * rightTailAnchor);
  const x = Math.min(Math.max(desiredX, minX), maxX);
  const y = Math.max(workArea.y + margin, naturalY);
  return { x, y, tailDirection };
}

module.exports = { calculateSubtitlePlacement };
