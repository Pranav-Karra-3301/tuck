import React from 'react';
import { Composition, Folder } from 'remotion';
import { HeroVideo } from './compositions/HeroVideo';
import {
  IntroScene,
  ProblemScene,
  InitScene,
  SyncScene,
  ApplyScene,
  FeaturesScene,
  CompareScene,
  OutroScene,
} from './scenes';

// Total duration: 40 seconds at 30fps = 1200 frames
const FPS = 30;
const TOTAL_DURATION = 40 * FPS;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HeroVideo"
        component={HeroVideo}
        durationInFrames={TOTAL_DURATION}
        fps={FPS}
        width={1920}
        height={1080}
      />

      <Folder name="Scenes">
        <Composition
          id="IntroScene"
          component={IntroScene}
          durationInFrames={3 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="ProblemScene"
          component={ProblemScene}
          durationInFrames={3 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="InitScene"
          component={InitScene}
          durationInFrames={7 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="SyncScene"
          component={SyncScene}
          durationInFrames={8 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="ApplyScene"
          component={ApplyScene}
          durationInFrames={6 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="FeaturesScene"
          component={FeaturesScene}
          durationInFrames={4.5 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="CompareScene"
          component={CompareScene}
          durationInFrames={5 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="OutroScene"
          component={OutroScene}
          durationInFrames={3.5 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
