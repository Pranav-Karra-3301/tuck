import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  initCommand,
  addCommand,
  removeCommand,
  syncCommand,
  pushCommand,
  pullCommand,
  restoreCommand,
  statusCommand,
  listCommand,
  diffCommand,
  configCommand,
  applyCommand,
  undoCommand,
  scanCommand,
  secretsCommand,
  encryptionCommand,
  doctorCommand,
} from '../../src/commands/index.js';

const buildProgram = (): Command => {
  const program = new Command('tuck');
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  program.addCommand(initCommand);
  program.addCommand(addCommand);
  program.addCommand(removeCommand);
  program.addCommand(syncCommand);
  program.addCommand(pushCommand);
  program.addCommand(pullCommand);
  program.addCommand(restoreCommand);
  program.addCommand(statusCommand);
  program.addCommand(listCommand);
  program.addCommand(diffCommand);
  program.addCommand(configCommand);
  program.addCommand(applyCommand);
  program.addCommand(undoCommand);
  program.addCommand(scanCommand);
  program.addCommand(secretsCommand);
  program.addCommand(encryptionCommand);
  program.addCommand(doctorCommand);

  return program;
};

describe('CLI smoke', () => {
  it('registers commands including doctor without duplicate names', () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());

    expect(names).toContain('doctor');
    expect(names).toContain('apply');
    expect(new Set(names).size).toBe(names.length);
  });

  it('parses doctor help and apply help', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'tuck', 'doctor', '--help'], { from: 'user' })
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });

    await expect(
      program.parseAsync(['node', 'tuck', 'apply', '--help'], { from: 'user' })
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
  });

  it('rejects unknown commands', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'tuck', 'does-not-exist'], { from: 'user' })
    ).rejects.toMatchObject({ code: 'commander.unknownCommand' });
  });
});
