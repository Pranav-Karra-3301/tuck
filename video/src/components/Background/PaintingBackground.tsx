import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from 'remotion';
import { colors } from '../../styles/theme';

type PaintingBackgroundProps = {
  painting: 'lake-george' | 'heart-of-the-andes' | 'rocky-mountains';
  startFrame?: number;
  overlayOpacity?: number;
  overlayColor?: string;
  zoom?: number;
  pan?: 'left' | 'right' | 'none';
};

const paintingFiles: Record<PaintingBackgroundProps['painting'], string> = {
  'lake-george': 'paintings/lake-george-free-study.webp',
  'heart-of-the-andes': 'paintings/heart-of-the-andes.webp',
  'rocky-mountains': 'paintings/rocky-mountains-landers-peak.webp',
};

export const PaintingBackground: React.FC<PaintingBackgroundProps> = ({
  painting,
  startFrame = 0,
  overlayOpacity = 0.3,
  overlayColor = colors.bgBase,
  zoom = 1.1,
  pan = 'none',
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  // Slow zoom over duration
  const scale = interpolate(
    frame,
    [0, durationInFrames],
    [1, zoom],
    { extrapolateRight: 'clamp' }
  );

  // Slow pan
  let translateX = 0;
  if (pan === 'left') {
    translateX = interpolate(frame, [0, durationInFrames], [0, -30]);
  } else if (pan === 'right') {
    translateX = interpolate(frame, [0, durationInFrames], [0, 30]);
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    >
      {/* Painting image with Ken Burns effect */}
      <Img
        src={staticFile(paintingFiles[painting])}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity,
          transform: `scale(${scale}) translateX(${translateX}px)`,
        }}
      />
      {/* Light overlay for readability */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: overlayColor,
          opacity: overlayOpacity,
        }}
      />
    </div>
  );
};

// Solid color background for contrast sections
export const SolidBackground: React.FC<{
  color?: string;
  startFrame?: number;
}> = ({ color = colors.bgBase, startFrame = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: color,
        opacity,
      }}
    />
  );
};
