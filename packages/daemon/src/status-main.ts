#!/usr/bin/env node
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
import { status } from './status.js';

status(process.env)
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
