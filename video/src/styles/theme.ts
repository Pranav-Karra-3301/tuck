// Light mode design system - Apple-style
export const colors = {
  // Primary palette
  accent: '#ff6b35',
  accentHover: '#ff8555',
  accentDark: '#e55a2b',

  // Light mode backgrounds
  bgBase: '#F7F7F4',           // Warm off-white
  bgElevated: '#FFFFFF',       // Pure white for cards
  bgSurface: '#EEEDE9',        // Subtle cream
  bgTerminal: '#1a1a1a',       // Dark terminal (contrast)

  // Text
  textPrimary: '#1a1a1a',      // Near black
  textSecondary: '#5a5a5a',    // Medium gray
  textMuted: '#8a8a8a',        // Light gray
  textOnDark: '#ffffff',       // White text on dark

  // Semantic
  success: '#22c55e',          // Vibrant green
  error: '#ef4444',
  cyan: '#0ea5e9',
  yellow: '#f59e0b',
  purple: '#8b5cf6',

  // Terminal specific (dark theme for contrast)
  terminalBg: '#0a0a0a',
  terminalTitlebar: '#1a1a1a',
  terminalBorder: 'rgba(0, 0, 0, 0.1)',
  terminalButtonRed: '#ff5f57',
  terminalButtonYellow: '#febc2e',
  terminalButtonGreen: '#28c840',
} as const;

export const fonts = {
  heading: 'Instrument Serif',
  mono: 'JetBrains Mono',
} as const;

export const spacing = {
  xs: 8,
  sm: 12,
  md: 24,
  lg: 48,
  xl: 80,
} as const;

// Faster timing for Apple-style pacing
export const timing = {
  charFrames: 1,             // FAST typing - 1 frame per char
  cursorBlinkFrames: 12,     // Faster blink
  lineDelayFrames: 4,        // Quick line reveals
  spinnerFrames: 3,          // Fast spinner
  sceneTransition: 8,        // Quick cuts
} as const;

// Terminal line types
export type LineType =
  | 'input'
  | 'output'
  | 'success'
  | 'error'
  | 'cyan'
  | 'yellow'
  | 'dim'
  | 'bold'
  | 'spinner'
  | 'empty';

export const lineTypeColors: Record<LineType, string> = {
  input: colors.textOnDark,
  output: '#a0a0a0',
  success: colors.success,
  error: colors.error,
  cyan: colors.cyan,
  yellow: colors.yellow,
  dim: '#666666',
  bold: colors.textOnDark,
  spinner: colors.purple,
  empty: 'transparent',
};
