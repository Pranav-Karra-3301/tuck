import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { TypingAnimation } from './TypingAnimation';
import { Spinner } from './Spinner';
import { type LineType } from '../../styles/theme';

// Light mode terminal colors
const lineTypeColors: Record<LineType, string> = {
  input: '#1a1a1a',
  output: '#555555',
  success: '#22c55e',  // Green
  error: '#ef4444',    // Red
  cyan: '#0891b2',     // Cyan for light bg
  yellow: '#ca8a04',   // Darker yellow for light bg
  dim: '#888888',
  bold: '#1a1a1a',
  spinner: '#8b5cf6',  // Purple
  empty: 'transparent',
};

type TerminalLineProps = {
  content: string;
  type: LineType;
  startFrame: number;
  duration: number;
  isSpinner?: boolean;
  isTyping?: boolean;
};

export const TerminalLine: React.FC<TerminalLineProps> = ({
  content,
  type,
  startFrame,
  duration,
  isSpinner = false,
  isTyping = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - startFrame;

  if (localFrame < 0) return null;

  // Entrance animation
  const entrance = spring({
    frame: localFrame,
    fps,
    config: { damping: 200, stiffness: 300 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateX = interpolate(entrance, [0, 1], [-6, 0]);

  const color = lineTypeColors[type];

  // Empty line
  if (type === 'empty') {
    return <div style={{ height: 18 }} />;
  }

  // Typing animation for input
  if (isTyping) {
    return (
      <div
        style={{
          opacity,
          transform: `translateX(${translateX}px)`,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <TypingAnimation text={content} startFrame={startFrame} />
      </div>
    );
  }

  // Spinner line
  if (isSpinner) {
    const spinnerDuration = duration - 12;
    const showCheckmark = localFrame >= spinnerDuration;
    const textWithoutSpinner = content.replace(/[\u25d0\u25d3\u25d1\u25d2]/, '').trim();

    return (
      <div
        style={{
          opacity,
          transform: `translateX(${translateX}px)`,
          fontSize: 14,
          lineHeight: 1.5,
          color: showCheckmark ? lineTypeColors.success : color,
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <Spinner startFrame={startFrame} duration={spinnerDuration} />
        <span style={{ marginLeft: 6 }}>
          {textWithoutSpinner.replace('...', showCheckmark ? '' : '...')}
        </span>
      </div>
    );
  }

  // Regular line
  return (
    <div
      style={{
        opacity,
        transform: `translateX(${translateX}px)`,
        color,
        fontSize: 14,
        lineHeight: 1.5,
        fontFamily: 'JetBrains Mono, monospace',
        whiteSpace: 'pre',
      }}
    >
      {content}
    </div>
  );
};
