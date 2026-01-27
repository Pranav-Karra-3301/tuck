import React from 'react';
import { AbsoluteFill, Sequence, useVideoConfig, interpolate, useCurrentFrame } from 'remotion';
import {
  IntroScene,
  ProblemScene,
  InitScene,
  SyncScene,
  ApplyScene,
  FeaturesScene,
  CompareScene,
  OutroScene,
} from '../scenes';
import { colors } from '../styles/theme';

// Scene durations (in seconds) - longer to let commands complete
const SCENE_DURATIONS = {
  intro: 3,         // 0:00 - 0:03
  problem: 3,       // 0:03 - 0:06
  init: 7,          // 0:06 - 0:13 - let init complete
  sync: 8,          // 0:13 - 0:21 - let sync complete
  apply: 6,         // 0:21 - 0:27 - let apply complete
  features: 4.5,    // 0:27 - 0:31.5
  compare: 5,       // 0:31.5 - 0:36.5
  outro: 3.5,       // 0:36.5 - 0:40
};

// Quick cut transition
const QuickCut: React.FC<{
  children: React.ReactNode;
  durationInFrames: number;
}> = ({ children, durationInFrames }) => {
  const frame = useCurrentFrame();
  const fadeFrames = 6;

  let opacity = 1;
  if (frame < fadeFrames) {
    opacity = interpolate(frame, [0, fadeFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  } else if (frame > durationInFrames - fadeFrames) {
    opacity = interpolate(
      frame,
      [durationInFrames - fadeFrames, durationInFrames],
      [1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
  }

  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const HeroVideo: React.FC = () => {
  const { fps } = useVideoConfig();

  const frames = {
    intro: Math.round(SCENE_DURATIONS.intro * fps),
    problem: Math.round(SCENE_DURATIONS.problem * fps),
    init: Math.round(SCENE_DURATIONS.init * fps),
    sync: Math.round(SCENE_DURATIONS.sync * fps),
    apply: Math.round(SCENE_DURATIONS.apply * fps),
    features: Math.round(SCENE_DURATIONS.features * fps),
    compare: Math.round(SCENE_DURATIONS.compare * fps),
    outro: Math.round(SCENE_DURATIONS.outro * fps),
  };

  let currentFrame = 0;
  const startFrames = {
    intro: currentFrame,
    problem: (currentFrame += frames.intro),
    init: (currentFrame += frames.problem),
    sync: (currentFrame += frames.init),
    apply: (currentFrame += frames.sync),
    features: (currentFrame += frames.apply),
    compare: (currentFrame += frames.features),
    outro: (currentFrame += frames.compare),
  };

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bgBase }}>
      <Sequence from={startFrames.intro} durationInFrames={frames.intro}>
        <QuickCut durationInFrames={frames.intro}>
          <IntroScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.problem} durationInFrames={frames.problem}>
        <QuickCut durationInFrames={frames.problem}>
          <ProblemScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.init} durationInFrames={frames.init}>
        <QuickCut durationInFrames={frames.init}>
          <InitScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.sync} durationInFrames={frames.sync}>
        <QuickCut durationInFrames={frames.sync}>
          <SyncScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.apply} durationInFrames={frames.apply}>
        <QuickCut durationInFrames={frames.apply}>
          <ApplyScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.features} durationInFrames={frames.features}>
        <QuickCut durationInFrames={frames.features}>
          <FeaturesScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.compare} durationInFrames={frames.compare}>
        <QuickCut durationInFrames={frames.compare}>
          <CompareScene />
        </QuickCut>
      </Sequence>

      <Sequence from={startFrames.outro} durationInFrames={frames.outro}>
        <QuickCut durationInFrames={frames.outro}>
          <OutroScene />
        </QuickCut>
      </Sequence>
    </AbsoluteFill>
  );
};
