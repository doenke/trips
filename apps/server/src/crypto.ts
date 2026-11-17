import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Keys for different purposes, all derived from SESSION_KEY. */
export class Keys {
  private readonly enc: Buffer;
  private readonly mac: Buffer;

  constructor(sessionKey: string) {
    const ikm = Buffer.from(sessionKey, 'utf8');
    this.enc = Buffer.from(hkdfSync('sha256', ikm, 'trips', 'secret-encryption', 32));
    this.mac = Buffer.from(hkdfSync('sha256', ikm, 'trips', 'feed-tokens', 32));
  }

  /** AES-256-GCM, output "v1.<iv>.<tag>.<ciphertext>" (base64url). */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.enc, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(box: string): string {
    const [v, iv, tag, data] = box.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('unbekanntes Format');
    const decipher = createDecipheriv('aes-256-gcm', this.enc, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  sign(value: string): string {
    return createHmac('sha256', this.mac).update(value).digest('base64url').slice(0, 32);
  }

  verify(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
