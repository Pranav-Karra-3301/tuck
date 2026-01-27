import React from 'react';
import { AbsoluteFill } from 'remotion';
import { MultiLineCallout } from '../components/Typography';
import { colors } from '../styles/theme';

export const IntroScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MultiLineCallout
          lines={[
            { text: 'tuck', size: 200, accent: true },
          ]}
          startFrame={5}
          staggerDelay={0}
          gap={0}
        />
        <div style={{ height: 20 }} />
        <MultiLineCallout
          lines={[
            { text: 'Your dotfiles. Everywhere.', size: 48 },
          ]}
          startFrame={25}
          staggerDelay={0}
          gap={0}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
