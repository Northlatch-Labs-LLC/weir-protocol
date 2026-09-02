// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The ladder constants the daemon mirrors from the contract.
 *
 * These stayed with the daemon when the BCS decoder moved to the SDK, and the split is the point:
 * the decoder answers "what does the vault say", these answer "when is it worth spending gas".
 * One is a chain shape, the other is a decision, and only the second belongs to this package.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LADDER_DEPTH, MAX_TRANCHES, MIN_STAKE_MIST } from '../src/domain/harvest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(HERE, '../../../sui-contracts/sources');
function moveSource(module: string): string {
  return readFileSync(resolve(SOURCES, `${module}.move`), 'utf8');
}

function constantOf(source: string, name: string): bigint {
  const match = new RegExp(`const\\s+${name}\\s*:\\s*\\w+\\s*=\\s*([0-9_]+)\\s*;`).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`constant ${name} not found in the Move source — renamed or removed`);
  }
  return BigInt(match[1].replace(/_/g, ''));
}

const source = readFileSync(resolve(SOURCES, 'stake_vault.move'), 'utf8');

describe('the daemon mirrors the ladder constants', () => {
  const ladder = moveSource('stake_ladder');

  it('LADDER_DEPTH', () => {
    expect(LADDER_DEPTH).toBe(constantOf(ladder, 'LADDER_DEPTH'));
  });

  it('MAX_TRANCHES', () => {
    expect(BigInt(MAX_TRANCHES)).toBe(constantOf(ladder, 'MAX_TRANCHES'));
  });

  it('MIN_STAKE_MIST', () => {
    expect(MIN_STAKE_MIST).toBe(constantOf(ladder, 'MIN_STAKE_MIST'));
  });

  it('the maturity rule still reads `+ LADDER_DEPTH <=`', () => {
    // The boundary the daemon reimplements. `<` instead of `<=` shifts the whole ladder by an
    // epoch, and the daemon would sit waiting for a maturity the contract already granted.
    expect(ladder).toContain('tranche.stake_activation_epoch() + LADDER_DEPTH <= current_epoch');
  });

  it('the one-rung-per-epoch rule still reads `> current_epoch`', () => {
    expect(ladder).toContain('stake_activation_epoch() > current_epoch');
  });
});

