#!/usr/bin/env node

import { createProgram } from './cmd/root.js';

try {
  await createProgram().parseAsync();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exitCode = 1;
  }
}
