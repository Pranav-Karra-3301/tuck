import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Cursor } from './Cursor';
import { timing } from '../../styles/theme';

type TypingAnimationProps = {
  text: string;
  startFrame: number;
  showCursor?: boolean;
  showPrompt?: boolean;
};

export const TypingAnimation: React.FC<TypingAnimationProps> = ({
  text,
  startFrame,
  showCursor = true,
  showPrompt = true,
}) => {
  const frame = useCurrentFrame();
  const localFrame = frame - startFrame;

  // Calculate how many characters to show
  const charsToShow = Math.min(
    text.length,
    Math.floor(Math.max(0, localFrame) / timing.charFrames)
  );

  const displayedText = text.slice(0, charsToShow);
  const isComplete = charsToShow >= text.length;

  return (
    <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {showPrompt && (
        <span style={{ color: '#ff6b35', marginRight: 8 }}>{'\u203a'}</span>
      )}
      <span style={{ color: '#1a1a1a' }}>{displayedText}</span>
      {showCursor && !isComplete && <Cursor />}
    </span>
  );
};
