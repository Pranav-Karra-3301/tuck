import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont } from '@remotion/google-fonts/InstrumentSerif';
import { colors } from '../../styles/theme';

const { fontFamily } = loadFont();

type FeatureCalloutProps = {
  text: string;
  startFrame: number;
  fontSize?: number;
  color?: string;
  accent?: boolean;
  delay?: number;
};

export const FeatureCallout: React.FC<FeatureCalloutProps> = ({
  text,
  startFrame,
  fontSize = 72,
  color = colors.textPrimary,
  accent = false,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame - delay,
    fps,
    config: { damping: 12, stiffness: 150, mass: 0.8 },
  });

  const scale = interpolate(entrance, [0, 1], [0.9, 1]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateY = interpolate(entrance, [0, 1], [30, 0]);

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        fontWeight: 400,
        color: accent ? colors.accent : color,
        transform: `scale(${scale}) translateY(${translateY}px)`,
        opacity,
        letterSpacing: '-0.03em',
        lineHeight: 1.1,
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
};

// Multi-line callout with staggered animation
type MultiLineCalloutProps = {
  lines: Array<{ text: string; accent?: boolean; size?: number }>;
  startFrame: number;
  gap?: number;
  staggerDelay?: number;
};

export const MultiLineCallout: React.FC<MultiLineCalloutProps> = ({
  lines,
  startFrame,
  gap = 8,
  staggerDelay = 6,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap,
      }}
    >
      {lines.map((line, index) => (
        <FeatureCallout
          key={index}
          text={line.text}
          startFrame={startFrame}
          delay={index * staggerDelay}
          accent={line.accent}
          fontSize={line.size || 72}
        />
      ))}
    </div>
  );
};
