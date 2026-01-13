/**
 * Banner and box utilities for tuck CLI
 * Provides ASCII art banner and styled boxes
 */

import boxen from 'boxen';
import { colors as c, boxStyles, indent } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// ASCII Art Banner (only for init and help)
// ─────────────────────────────────────────────────────────────────────────────

export const banner = (): void => {
  const art = `
 ████████╗██╗   ██╗ ██████╗██╗  ██╗
 ╚══██╔══╝██║   ██║██╔════╝██║ ██╔╝
    ██║   ██║   ██║██║     █████╔╝ 
    ██║   ██║   ██║██║     ██╔═██╗ 
    ██║   ╚██████╔╝╚██████╗██║  ██╗
    ╚═╝    ╚═════╝  ╚═════╝╚═╝  ╚═╝`;

  console.log(c.brand(art));
  console.log(c.muted('    Modern Dotfiles Manager\n'));
};

// ─────────────────────────────────────────────────────────────────────────────
// Mini Banner (compact version for other contexts)
// ─────────────────────────────────────────────────────────────────────────────

export const miniBanner = (): void => {
  console.log(boxen(c.brandBold('tuck') + c.muted(' · Modern Dotfiles Manager'), boxStyles.header));
  console.log();
};

// ─────────────────────────────────────────────────────────────────────────────
// Help Text
// ─────────────────────────────────────────────────────────────────────────────

export const customHelp = (version: string): string => {
  const title = boxen(c.brandBold('tuck') + c.muted(` v${version}`), boxStyles.header);

  const quickStart = `
${c.brandBold('Quick Start:')}
${indent()}${c.brand('tuck init')}          Set up tuck
${indent()}${c.brand('tuck add <file>')}    Track a dotfile
${indent()}${c.brand('tuck sync')}          Commit changes
${indent()}${c.brand('tuck push')}          Push to remote

${c.brandBold('New Machine:')}
${indent()}${c.brand('tuck apply <user>')}  Apply dotfiles from GitHub
`;

  const commands = `
${c.brandBold('Commands:')}
${indent()}${c.brand('Getting Started')}
${indent()}${indent()}init              Initialize tuck
${indent()}${indent()}scan              Detect dotfiles
${indent()}${indent()}apply <source>    Apply from repo

${indent()}${c.brand('Managing Files')}
${indent()}${indent()}add <paths...>    Track files
${indent()}${indent()}remove <paths...> Untrack files
${indent()}${indent()}list              List tracked
${indent()}${indent()}status            Show status

${indent()}${c.brand('Syncing')}
${indent()}${indent()}sync              Commit changes
${indent()}${indent()}push              Push to remote
${indent()}${indent()}pull              Pull from remote
${indent()}${indent()}diff              Show changes

${indent()}${c.brand('Restoring')}
${indent()}${indent()}restore           Restore files
${indent()}${indent()}undo              Undo last apply

${indent()}${c.brand('Config')}
${indent()}${indent()}config            Manage settings
`;

  const footer = `
${c.muted('Run')} ${c.brand('tuck <command> --help')} ${c.muted('for details')}
${c.muted('Docs:')} ${c.brand('https://github.com/Pranav-Karra-3301/tuck')}
`;

  return `${title}\n${quickStart}${commands}${footer}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled Boxes
// ─────────────────────────────────────────────────────────────────────────────

export const welcomeBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      ...boxStyles.info,
      title,
      titleAlignment: 'center',
    })
  );
};

export const successBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      ...boxStyles.success,
      title: title || 'Success',
      titleAlignment: 'center',
    })
  );
};

export const errorBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      ...boxStyles.error,
      title: title || 'Error',
      titleAlignment: 'center',
    })
  );
};

export const infoBox = (message: string, title?: string): void => {
  console.log(
    boxen(message, {
      ...boxStyles.info,
      title,
      titleAlignment: 'center',
    })
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Next Steps Box
// ─────────────────────────────────────────────────────────────────────────────

export const nextSteps = (steps: string[]): void => {
  const content = steps.map((step, i) => `${c.brand(`${i + 1}.`)} ${step}`).join('\n');

  console.log(
    boxen(content, {
      padding: 1,
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'cyan',
      title: 'Next Steps',
      titleAlignment: 'left',
    })
  );
};
