import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont } from '@remotion/google-fonts/JetBrainsMono';
import { colors } from '../../styles/theme';

const { fontFamily } = loadFont();

type CommandHighlightProps = {
  command: string;
  startFrame: number;
  fontSize?: number;
};

export const CommandHighlight: React.FC<CommandHighlightProps> = ({
  command,
  startFrame,
  fontSize = 48,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 15, stiffness: 200 },
  });

  const scale = interpolate(entrance, [0, 1], [0.8, 1]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '16px 32px',
        backgroundColor: colors.terminalBg,
        borderRadius: 12,
        transform: `scale(${scale})`,
        opacity,
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.15)',
      }}
    >
      <span style={{ color: colors.accent, fontFamily, fontSize }}>{'>'}</span>
      <span style={{ color: colors.textOnDark, fontFamily, fontSize, fontWeight: 500 }}>
        {command}
      </span>
    </div>
  );
};
