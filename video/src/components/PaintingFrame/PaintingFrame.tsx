import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from 'remotion';

type PaintingType = 'lake-george' | 'heart-of-the-andes' | 'rocky-mountains';

type PaintingFrameProps = {
  painting: PaintingType;
  startFrame?: number;
  children?: React.ReactNode;
};

const paintingFiles: Record<PaintingType, string> = {
  'lake-george': 'paintings/lake-george-free-study.webp',
  'heart-of-the-andes': 'paintings/heart-of-the-andes.webp',
  'rocky-mountains': 'paintings/rocky-mountains-landers-peak.webp',
};

export const PaintingFrame: React.FC<PaintingFrameProps> = ({
  painting,
  startFrame = 0,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 20, stiffness: 100 },
  });

  const scale = interpolate(entrance, [0, 1], [0.96, 1]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  // Consistent large size - fills most of the screen
  const width = 1280;
  const height = 640;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          width,
          height,
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0, 0, 0, 0.35)',
          position: 'relative',
        }}
      >
        <Img
          src={staticFile(paintingFiles[painting])}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />

        {children && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
};
