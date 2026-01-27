import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { loadFont as loadSerif } from '@remotion/google-fonts/InstrumentSerif';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { colors } from '../../styles/theme';

const { fontFamily: serifFont } = loadSerif();
const { fontFamily: monoFont } = loadMono();

type TuckCTAProps = {
  startFrame: number;
};

export const TuckCTA: React.FC<TuckCTAProps> = ({ startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // URL animation
  const urlEntrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 12, stiffness: 120 },
  });

  const urlScale = interpolate(urlEntrance, [0, 1], [0.8, 1]);
  const urlOpacity = interpolate(urlEntrance, [0, 1], [0, 1]);

  // Install command animation (delayed)
  const installEntrance = spring({
    frame: frame - startFrame - 15,
    fps,
    config: { damping: 18, stiffness: 150 },
  });

  const installOpacity = interpolate(installEntrance, [0, 1], [0, 1]);
  const installY = interpolate(installEntrance, [0, 1], [20, 0]);

  // Platform info animation (more delayed)
  const platformEntrance = spring({
    frame: frame - startFrame - 28,
    fps,
    config: { damping: 200 },
  });

  const platformOpacity = interpolate(platformEntrance, [0, 1], [0, 1]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
      }}
    >
      {/* tuck.sh in black */}
      <div
        style={{
          fontFamily: serifFont,
          fontSize: 180,
          fontWeight: 400,
          color: colors.textPrimary,
          transform: `scale(${urlScale})`,
          opacity: urlOpacity,
          letterSpacing: '-0.03em',
        }}
      >
        tuck.sh
      </div>

      {/* Installation commands */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          opacity: installOpacity,
          transform: `translateY(${installY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 28,
            color: colors.textSecondary,
            backgroundColor: 'rgba(0,0,0,0.04)',
            padding: '16px 32px',
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.08)',
          }}
        >
          <span style={{ color: colors.textMuted }}>$</span>{' '}
          <span style={{ color: colors.textPrimary }}>npm install -g @prnv/tuck</span>
        </div>
      </div>

      {/* Platform compatibility */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 32,
          opacity: platformOpacity,
          marginTop: 20,
        }}
      >
        <PlatformBadge label="macOS" />
        <PlatformBadge label="Linux" />
        <PlatformBadge label="Windows" beta />
        <div
          style={{
            fontSize: 18,
            color: colors.textSecondary,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          Open Source
        </div>
      </div>
    </div>
  );
};

const PlatformBadge: React.FC<{ label: string; beta?: boolean }> = ({ label, beta }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 18,
      color: colors.textSecondary,
      fontWeight: 500,
    }}
  >
    <span style={{ color: colors.success, fontSize: 20 }}>✓</span>
    {label}
    {beta && (
      <span
        style={{
          fontSize: 12,
          color: colors.accent,
          backgroundColor: 'rgba(255,107,53,0.12)',
          padding: '2px 8px',
          borderRadius: 4,
          fontWeight: 600,
        }}
      >
        BETA
      </span>
    )}
  </div>
);
