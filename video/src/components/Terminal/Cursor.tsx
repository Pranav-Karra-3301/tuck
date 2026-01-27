import React from 'react';
import { useCurrentFrame } from 'remotion';
import { timing } from '../../styles/theme';

type CursorProps = {
  visible?: boolean;
  symbol?: string;
};

export const Cursor: React.FC<CursorProps> = ({
  visible = true,
  symbol = '\u2588',
}) => {
  const frame = useCurrentFrame();

  if (!visible) return null;

  const blinkCycle = Math.floor(frame / timing.cursorBlinkFrames) % 2;
  const opacity = blinkCycle === 0 ? 1 : 0;

  return (
    <span
      style={{
        opacity,
        color: '#1a1a1a',
        marginLeft: 1,
      }}
    >
      {symbol}
    </span>
  );
};
