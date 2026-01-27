import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont } from '@remotion/google-fonts/InstrumentSerif';
import { colors } from '../../styles/theme';

const { fontFamily } = loadFont();

type TitleProps = {
  text: string;
  startFrame: number;
  fontSize?: number;
  color?: string;
  onDark?: boolean;
};

export const Title: React.FC<TitleProps> = ({
  text,
  startFrame,
  fontSize = 100,
  color,
  onDark = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 12, stiffness: 120 },
  });

  const scale = interpolate(entrance, [0, 1], [0.85, 1]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateY = interpolate(entrance, [0, 1], [25, 0]);

  const textColor = color || (onDark ? colors.textOnDark : colors.textPrimary);

  return (
    <h1
      style={{
        fontFamily,
        fontSize,
        fontWeight: 400,
        color: textColor,
        transform: `scale(${scale}) translateY(${translateY}px)`,
        opacity,
        margin: 0,
        letterSpacing: '-0.02em',
      }}
    >
      {text}
    </h1>
  );
};
