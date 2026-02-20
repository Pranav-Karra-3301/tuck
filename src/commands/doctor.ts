import { Command } from 'commander';
import { logger, prompts } from '../ui/index.js';
import {
  DOCTOR_CATEGORIES,
  getDoctorExitCode,
  runDoctorChecks,
  type DoctorCategory,
  type DoctorReport,
} from '../lib/doctor.js';
import type { DoctorOptions } from '../types.js';

const isDoctorCategory = (value: string): value is DoctorCategory => {
  return (DOCTOR_CATEGORIES as readonly string[]).includes(value);
};

const formatCheckId = (id: string): string => {
  return id.replace('.', ': ');
};

const printHumanReport = (report: DoctorReport): void => {
  prompts.intro('tuck doctor');

  for (const check of report.checks) {
    const label = `[${check.category}] ${formatCheckId(check.id)} - ${check.message}`;

    if (check.status === 'pass') {
      logger.success(label);
    } else if (check.status === 'warn') {
      logger.warning(label);
    } else {
      logger.error(label);
    }

    if (check.details) {
      logger.dim(`  Details: ${check.details}`);
    }
    if (check.fix) {
      logger.dim(`  Fix: ${check.fix}`);
    }
  }

  logger.blank();
  logger.info(
    `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`
  );
};

export const runDoctor = async (options: DoctorOptions = {}): Promise<DoctorReport> => {
  const report = await runDoctorChecks({
    category: options.category,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  const exitCode = getDoctorExitCode(report, options.strict);
  process.exitCode = exitCode;

  if (!options.json) {
    if (exitCode === 0) {
      prompts.outro('Doctor checks completed successfully');
    } else if (exitCode === 2) {
      prompts.outro('Doctor completed with warnings (strict mode enabled)');
    } else {
      prompts.outro('Doctor found blocking issues');
    }
  }

  return report;
};

export const doctorCommand = new Command('doctor')
  .description('Run repository health and safety diagnostics')
  .option('--json', 'Output as JSON')
  .option('--strict', 'Exit non-zero on warnings')
  .option(
    '-c, --category <category>',
    `Run only one category (${DOCTOR_CATEGORIES.join('|')})`,
    (value: string): DoctorCategory => {
      if (!isDoctorCategory(value)) {
        throw new Error(
          `Invalid category "${value}". Expected one of: ${DOCTOR_CATEGORIES.join(', ')}`
        );
      }
      return value;
    }
  )
  .action(async (options: DoctorOptions) => {
    await runDoctor(options);
  });
