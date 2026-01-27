import React from 'react';
import { AbsoluteFill } from 'remotion';
import { PaintingFrame } from '../components/PaintingFrame';
import { Terminal } from '../components/Terminal';
import { FeatureCallout } from '../components/Typography';
import { applyScript } from '../data/terminalScripts';
import { colors } from '../styles/theme';

export const ApplyScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      {/* Feature callout */}
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
        <FeatureCallout text="Clone anyone's setup." startFrame={5} fontSize={44} />
        <FeatureCallout text="Keep your customizations." startFrame={18} fontSize={32} accent />
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
        <PaintingFrame painting="heart-of-the-andes" startFrame={10}>
          <Terminal
            lines={applyScript}
            startFrame={30}
            title="tuck — ~/.tuck"
          />
        </PaintingFrame>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
