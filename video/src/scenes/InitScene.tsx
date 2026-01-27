import React from 'react';
import { AbsoluteFill } from 'remotion';
import { PaintingFrame } from '../components/PaintingFrame';
import { Terminal } from '../components/Terminal';
import { FeatureCallout } from '../components/Typography';
import { initScript } from '../data/terminalScripts';
import { colors } from '../styles/theme';

export const InitScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      {/* Feature callout at top */}
      <div
        style={{
          position: 'absolute',
          top: 50,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <FeatureCallout text="One command to start." startFrame={5} fontSize={44} />
        <FeatureCallout text="Auto-detects everything." startFrame={18} fontSize={36} accent />
      </div>

      {/* Painting frame with terminal - uses consistent sizing */}
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: 60,
        }}
      >
        <PaintingFrame painting="lake-george" startFrame={10}>
          <Terminal
            lines={initScript}
            startFrame={30}
            title="tuck — ~/.tuck"
          />
        </PaintingFrame>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
