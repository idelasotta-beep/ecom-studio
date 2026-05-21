/**
 * Symmetric encryption for sensitive credentials stored in the JSON DB.
 * Uses AES-256-GCM with a key resolved (in priority order):
 *   1. process.env.SHOPIFY_ENCRYPTION_KEY  (hex or base64)
 *   2. on-disk key at server/.shopify-encryption-key (auto-generated on first run)
 *
 * The on-disk fallback means stored secrets survive server restarts without
 * requiring the user to set an env var. The key file is created with mode 0600
 * (owner-only) and should be excluded from version control.
 */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;

const KEY_FILE = path.join(__dirname, '..', '.shopify-encryption-key');

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.SHOPIFY_ENCRYPTION_KEY;
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      cachedKey = Buffer.from(envKey, 'hex');
    } else {
      try {
        const buf = Buffer.from(envKey, 'base64');
        if (buf.length === KEY_LEN) cachedKey = buf;
        else throw new Error('Invalid base64 key length');
      } catch (_) {
        cachedKey = crypto.createHash('sha256').update(envKey).digest();
      }
    }
    return cachedKey;
  }

  // No env var — read or create the on-disk key
  if (fs.existsSync(KEY_FILE)) {
    try {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        cachedKey = Buffer.from(raw, 'hex');
        return cachedKey;
      }
      console.warn('[shopify-crypto] key file has invalid format — regenerating.');
    } catch (err) {
      console.warn('[shopify-crypto] could not read key file:', err.message);
    }
  }
  // Generate + persist a fresh key
  const fresh = crypto.randomBytes(KEY_LEN);
  try {
    fs.writeFileSync(KEY_FILE, fresh.toString('hex'), { mode: 0o600 });
    console.log('[shopify-crypto] generated persistent encryption key at', KEY_FILE);
  } catch (err) {
    console.warn('[shopify-crypto] could not persist key file (in-memory only):', err.message);
  }
  cachedKey = fresh;
  return cachedKey;
}

/**
 * Encrypts a plaintext string. Returns a base64 string with iv + authTag + ciphertext concatenated.
 */
function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypts a value previously produced by encrypt(). Returns null on failure.
 */
function decrypt(payload) {
  if (payload == null) return null;
  try {
    const key = getKey();
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LEN + 16) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const enc = buf.subarray(IV_LEN + 16);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch (err) {
    console.error('[shopify-crypto] decrypt failed:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
