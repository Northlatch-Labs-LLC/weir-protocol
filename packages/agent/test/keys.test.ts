// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The agent's key, and the one thing that must never appear in a log.
 *
 * The input to a key parser is a private key. Crypto libraries routinely include the offending
 * value in a parse error, so `keys.ts` writes its own message and discards the library's. Losing
 * the detail is the point: the only fact a caller needs is "that string is not a Sui Ed25519
 * secret", and the one fact they must never get in a log aggregator is the string itself.
 *
 * Ported from the unrerunnable scratchpad harness.
 */

import { describe, expect, it } from 'vitest';

import {
  agentKeyFromEnv,
  agentKeyFromSecret,
  generateAgentKey,
  normaliseAddress,
  sameAddress,
} from '../src/index.js';

describe('loading a key', () => {
  it('a generated secret round-trips', () => {
    const { key, secret } = generateAgentKey();
    const loaded = agentKeyFromSecret(secret);
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.value.address).toBe(key.address);
  });

  it('raw hex is refused, however plausible it looks', () => {
    // Deliberately not accepted: 32 bytes of hex is indistinguishable from a public key, an object
    // id and a transaction digest by inspection, and a loader that accepts every 32-byte thing is
    // a loader that will one day be handed the wrong one.
    expect(agentKeyFromSecret(`0x${'a'.repeat(64)}`).ok).toBe(false);
  });

  it('an empty secret is refused', () => {
    expect(agentKeyFromSecret('   ').ok).toBe(false);
  });

  it('a missing environment variable names the variable', () => {
    const reading = agentKeyFromEnv({});
    expect(reading.ok).toBe(false);
    // "The signing secret is empty" sends an operator through the code. Naming the variable sends
    // them to the one line that fixes it.
    if (!reading.ok) expect(reading.failure.detail).toContain('PROJECTX_SOCIAL_AGENT_SECRET');
  });
});

describe('a failed decode NEVER quotes its input', () => {
  it('does not echo an obviously bad string', () => {
    const reading = agentKeyFromSecret('not-a-key');
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.failure.detail).not.toContain('not-a-key');
      expect(reading.failure.detail).toContain('deliberately not shown');
    }
  });

  it('does not echo a CORRUPTED REAL secret either — the dangerous case', () => {
    // The one that matters. A real key with three characters changed still contains almost the
    // whole key, and it is exactly the string somebody pastes when it will not load.
    const { secret } = generateAgentKey();
    const corrupted = `${secret.slice(0, -3)}xyz`;
    const reading = agentKeyFromSecret(corrupted);
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.failure.detail).not.toContain(secret.slice(10, 40));
      expect(reading.failure.detail).not.toContain(corrupted);
    }
  });

  it('an AgentKey exposes no accessor that returns the secret', () => {
    const { key } = generateAgentKey();
    // A caller who logs an AgentKey prints an address. `secret` is returned once, as a separate
    // field the caller has to destructure deliberately, and never lands on this object.
    expect(Object.keys(key).sort()).toEqual(['address', 'keypair']);
    expect(JSON.stringify(key)).not.toContain('suiprivkey');
  });
});

describe('addresses compare by value, not by spelling', () => {
  it('pads a short address to 32 bytes', () => {
    expect(normaliseAddress('0x2')).toBe(`0x${'0'.repeat(63)}2`);
  });

  it('folds case', () => {
    expect(normaliseAddress('0xAB')).toBe(normaliseAddress('0xab'));
  });

  it('treats padded and unpadded forms as the same account', () => {
    // Comparing raw strings works until it does not, and the failure is "you cannot pay your own
    // vault" shown to somebody who is not the owner.
    expect(sameAddress('0x2', `0x${'0'.repeat(63)}2`)).toBe(true);
  });

  it('does not claim two different addresses are the same', () => {
    expect(sameAddress('0x2', '0x3')).toBe(false);
  });

  it('leaves an unrecognisable string alone rather than padding nonsense', () => {
    expect(normaliseAddress('not-an-address')).toBe('not-an-address');
  });
});
