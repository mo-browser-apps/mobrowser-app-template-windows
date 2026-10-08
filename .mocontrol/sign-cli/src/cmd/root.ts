import { Command } from 'commander';

import { registerDoctorCommand } from './doctor.js';
import { registerAuthCommand } from './auth.js';
import { registerReleaseCommand } from './release.js';

export function createProgram(): Command {
  const program = new Command()
    .name('mocontrol-cli')
    .description('MVP signing and notarization automation for MoBrowser apps')
    .version('0.1.0');
  registerAuthCommand(program);
  registerDoctorCommand(program);
  registerReleaseCommand(program);
  return program;
}
