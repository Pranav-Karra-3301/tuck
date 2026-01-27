import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { FeatureCallout } from '../components/Typography';
import { colors } from '../styles/theme';

const { fontFamily: monoFont } = loadMono();

const ComparisonItem: React.FC<{
  other: string;
  tuck: string;
  startFrame: number;
}> = ({ other, tuck, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 15, stiffness: 180 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const scale = interpolate(entrance, [0, 1], [0.95, 1]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 40,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      {/* Other tools - dimmed */}
      <div
        style={{
          width: 320,
          textAlign: 'right',
          fontSize: 22,
          color: colors.textMuted,
          fontWeight: 400,
        }}
      >
        {other}
      </div>

      {/* Arrow */}
      <div
        style={{
          width: 60,
          textAlign: 'center',
          fontSize: 32,
          color: colors.accent,
        }}
      >
        →
      </div>

      {/* Tuck command - highlighted */}
      <div
        style={{
          width: 320,
          fontFamily: monoFont,
          fontSize: 22,
          color: colors.textPrimary,
          fontWeight: 600,
          backgroundColor: 'rgba(255,107,53,0.08)',
          padding: '10px 18px',
          borderRadius: 8,
          border: '1px solid rgba(255,107,53,0.2)',
        }}
      >
        <span style={{ color: colors.accent }}>❯</span> {tuck}
      </div>
    </div>
  );
};

export const CompareScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      <div
        style={{
          position: 'absolute',
          top: 80,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <FeatureCallout text="Simpler than the rest." startFrame={5} fontSize={52} />
      </div>

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          paddingTop: 50,
        }}
      >
        <ComparisonItem other="Manual git workflows" tuck="tuck sync" startFrame={20} />
        <ComparisonItem other="YAML config files" tuck="tuck init" startFrame={32} />
        <ComparisonItem other="Template languages" tuck="tuck apply" startFrame={44} />
        <ComparisonItem other="Complex setup scripts" tuck="tuck status" startFrame={56} />
      </AbsoluteFill>

      {/* Bottom highlight */}
      <div
        style={{
          position: 'absolute',
          bottom: 80,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <FeatureCallout text="One tool. Zero config." startFrame={68} fontSize={32} accent />
      </div>
    </AbsoluteFill>
  );
};
