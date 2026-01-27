import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TuckCTA } from '../components/CTA';
import { colors } from '../styles/theme';

export const OutroScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TuckCTA startFrame={8} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
