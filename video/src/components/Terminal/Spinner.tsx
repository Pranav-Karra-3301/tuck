import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { timing } from '../../styles/theme';

type SpinnerProps = {
  startFrame: number;
  duration: number;
};

const SPINNER_CHARS = ['\u25d0', '\u25d3', '\u25d1', '\u25d2'];

export const Spinner: React.FC<SpinnerProps> = ({
  startFrame,
  duration,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - startFrame;

  if (localFrame < 0) return null;

  // If duration passed, show checkmark
  if (localFrame >= duration) {
    const checkmarkSpring = spring({
      frame: localFrame - duration,
      fps,
      config: { damping: 15, stiffness: 200 },
    });

    const scale = interpolate(checkmarkSpring, [0, 1], [0.5, 1]);

    return (
      <span
        style={{
          color: '#22c55e',
          transform: `scale(${scale})`,
          display: 'inline-block',
        }}
      >
        {'\u2713'}
      </span>
    );
  }

  // Show spinning animation
  const spinnerIndex = Math.floor(localFrame / timing.spinnerFrames) % SPINNER_CHARS.length;

  return (
    <span style={{ color: '#8b5cf6' }}>
      {SPINNER_CHARS[spinnerIndex]}
    </span>
  );
};
