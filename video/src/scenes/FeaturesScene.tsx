import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { FeatureCallout } from '../components/Typography';
import { loadFont } from '@remotion/google-fonts/JetBrainsMono';
import { colors } from '../styles/theme';

const { fontFamily } = loadFont();

const features = [
  { command: 'tuck secrets scan', label: 'Scan for leaked secrets' },
  { command: 'tuck undo --latest', label: 'Time machine backups' },
  { command: 'tuck status', label: 'See everything at a glance' },
];

const FeatureItem: React.FC<{
  command: string;
  label: string;
  startFrame: number;
}> = ({ command, label, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 15, stiffness: 180 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const translateX = interpolate(entrance, [0, 1], [30, 0]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 32,
        opacity,
        transform: `translateX(${translateX}px)`,
      }}
    >
      {/* Light mode command box - fixed width for consistency */}
      <div
        style={{
          backgroundColor: '#ffffff',
          padding: '16px 28px',
          borderRadius: 12,
          fontFamily,
          fontSize: 22,
          color: colors.textPrimary,
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          border: '1px solid rgba(0,0,0,0.06)',
          width: 340,
        }}
      >
        <span style={{ color: colors.accent }}>❯</span> {command}
      </div>
      <div
        style={{
          fontSize: 24,
          color: colors.textSecondary,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
    </div>
  );
};

export const FeaturesScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 100,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <FeatureCallout text="And so much more." startFrame={5} fontSize={56} accent />
      </div>

      {/* Features list */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 32,
          paddingTop: 60,
        }}
      >
        {features.map((feature, index) => (
          <FeatureItem
            key={index}
            command={feature.command}
            label={feature.label}
            startFrame={20 + index * 18}
          />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
