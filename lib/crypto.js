// Encrypts ad-account tokens before they touch disk. Uses Node's built-in
// crypto (AES-256-GCM) — no extra dependency, no native module, so this
// still runs on a client's laptop with nothing but Node installed.
//
// The key lives in its own file next to the data file, generated on first
// run, chmod 600. This is "safe from someone opening the JSON file or
// grabbing a backup of it," not "safe from someone with full access to
// the same machine and the key file" — there's no secure enclave on a
// client's laptop, so that's the realistic bar, not a false promise of more.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(__dirname, '..', 'argus_pulse.key');

function getOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) { /* best-effort on platforms without POSIX perms */ }
  return key;
}

const KEY = getOrCreateKey();
const ENCRYPTED_FORMAT = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i; // iv(12B):authTag(16B):ciphertext

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  // Back-compat: data files written before encryption existed have raw
  // plaintext tokens sitting in them. Don't choke on those — pass them
  // through as-is; the next save() will re-encrypt via addAdAccount/update.
  if (!ENCRYPTED_FORMAT.test(value)) return value;
  try {
    const [ivHex, tagHex, dataHex] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('Token decrypt failed (corrupted or wrong key) — treating as unset:', e.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
