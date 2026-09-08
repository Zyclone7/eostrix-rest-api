import bcrypt from 'bcryptjs';
import { env } from '../config/env';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A real hash, computed once, used only as a timing decoy. bcrypt.compare()
 * against a malformed hash returns instantly and would defeat the purpose.
 */
let decoyHash: Promise<string> | null = null;

/**
 * Burns roughly the same time as a genuine password comparison. Called when
 * login is attempted for an unknown email so that response timing does not
 * reveal which addresses are registered.
 */
export async function fakePasswordCheck(): Promise<void> {
  decoyHash ??= bcrypt.hash('timing-decoy-value', env.BCRYPT_ROUNDS);
  await bcrypt.compare('timing-decoy-attempt', await decoyHash);
}
