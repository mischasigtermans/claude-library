import { ingestCodeSessions } from './tools/index.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const onlyFlag = args.indexOf('--only');
const only = onlyFlag >= 0 ? args[onlyFlag + 1] : undefined;

const report = await ingestCodeSessions({ full, only });
process.stdout.write(
  `library: ingested ${report.ingested}, unchanged ${report.skipped}, ${report.messages} messages, ${report.redactions} redactions\n`,
);
for (const f of report.failureSamples) process.stderr.write(`library: ${f}\n`);
process.exit(report.failed > 0 ? 1 : 0);
