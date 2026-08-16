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
  // through as-is. (Note: nothing currently re-encrypts these on the next
  // save — there's no "update ad account credentials" route yet, only
  // "add a new one" — so a legacy plaintext token stays plaintext until
  // the account is re-added. Fine today since no real data predates
  // encryption; worth building an update route if that ever changes.)
  if (!ENCRYPTED_FORMAT.test(value)) return value;
  try {
    const [ivHex, tagHex, dataHex] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    // A value WAS stored here and genuinely failed to decrypt (wrong or
    // lost key file, corrupted data) — this must never look the same as
    // "no token was ever set." Silently returning null here used to mean
    // sync would quietly fall back to demo data with zero indication
    // anything was wrong — someone's real ad data could stop syncing and
    // the only trace would be a server console line nobody's watching.
    // Throw instead, so callers can tell the two cases apart and surface
    // this loudly instead of degrading silently.
    const err = new Error('Stored credentials could not be decrypted — the encryption key file may have changed or been lost. Re-enter this account\'s credentials.');
    err.isDecryptFailure = true;
    throw err;
  }
}

module.exports = { encrypt, decrypt };
