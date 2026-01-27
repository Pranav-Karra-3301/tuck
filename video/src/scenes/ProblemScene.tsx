import React from 'react';
import { AbsoluteFill } from 'remotion';
import { MultiLineCallout } from '../components/Typography';
import { colors } from '../styles/theme';

export const ProblemScene: React.FC = () => {
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
            { text: 'New machine?', size: 56 },
            { text: 'Lost configs?', size: 56 },
            { text: 'Never again.', size: 64, accent: true },
          ]}
          startFrame={5}
          staggerDelay={15}
          gap={16}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
