import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont } from '@remotion/google-fonts/InstrumentSerif';
import { colors } from '../../styles/theme';

const { fontFamily } = loadFont();

type TaglineProps = {
  text: string;
  startFrame: number;
  fontSize?: number;
  color?: string;
};

export const Tagline: React.FC<TaglineProps> = ({
  text,
  startFrame,
  fontSize = 32,
  color = colors.textSecondary,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateY = interpolate(entrance, [0, 1], [15, 0]);

  return (
    <p
      style={{
        fontFamily,
        fontSize,
        fontWeight: 400,
        color,
        transform: `translateY(${translateY}px)`,
        opacity,
        margin: 0,
        fontStyle: 'italic',
      }}
    >
      {text}
    </p>
  );
};
