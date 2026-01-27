import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { TerminalLine } from './TerminalLine';
import type { TerminalLine as TerminalLineData } from '../../data/terminalScripts';

type TerminalProps = {
  lines: TerminalLineData[];
  startFrame: number;
  width?: number;
  height?: number;
  title?: string;
};

const TerminalTitlebar: React.FC<{ title: string }> = ({ title }) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '12px 16px',
        backgroundColor: '#f5f5f5',
        borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
        borderRadius: '12px 12px 0 0',
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ddd' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ddd' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ddd' }} />
      </div>
      <div
        style={{
          flex: 1,
          textAlign: 'center',
          color: '#888',
          fontSize: 13,
          fontFamily: 'JetBrains Mono, monospace',
          marginRight: 52,
        }}
      >
        {title}
      </div>
    </div>
  );
};

export const Terminal: React.FC<TerminalProps> = ({
  lines,
  startFrame,
  width = 520,
  height = 400,
  title = 'tuck',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 18, stiffness: 120 },
  });

  const translateY = interpolate(entrance, [0, 1], [25, 0]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const scale = interpolate(entrance, [0, 1], [0.97, 1]);

  let cumulativeFrame = startFrame + 12;
  const linesWithStartFrames = lines.map((line) => {
    const lineStartFrame = cumulativeFrame;
    cumulativeFrame += line.duration;
    return { ...line, startFrame: lineStartFrame };
  });

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.3)',
        transform: `translateY(${translateY}px) scale(${scale})`,
        opacity,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#ffffff',
        border: '1px solid rgba(0, 0, 0, 0.1)',
      }}
    >
      <TerminalTitlebar title={title} />
      <div
        style={{
          flex: 1,
          padding: '14px 18px',
          overflow: 'hidden',
          backgroundColor: '#ffffff',
        }}
      >
        {linesWithStartFrames.map((line, index) => (
          <TerminalLine
            key={index}
            content={line.content}
            type={line.type}
            startFrame={line.startFrame}
            duration={line.duration}
            isSpinner={line.isSpinner}
            isTyping={line.isTyping}
          />
        ))}
      </div>
    </div>
  );
};
