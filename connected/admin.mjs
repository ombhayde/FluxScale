import { openStore, token, digest, passwordHash, transaction } from './store.mjs';
const [command, rawEmail] = process.argv.slice(2); const email = rawEmail?.trim().toLowerCase();
if (!['invite', 'reset-password'].includes(command) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Usage: node admin.mjs invite|reset-password EMAIL');
const db = openStore(process.env.FLUXSCALE_HUB_DATABASE ?? 'data/connected.sqlite');
try {
  if (command === 'invite') { const invite = token(); db.prepare('DELETE FROM invites WHERE email=?').run(email); db.prepare('INSERT INTO invites VALUES(?,?,?)').run(digest(invite), email, Date.now() + 86400000); console.log(`One-use invitation (24 hours): ${invite}`); }
  else {
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(email); if (!user) throw Error('User not found');
    const password = token(); const next = await passwordHash(password);
    transaction(db, () => { db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(next.salt, next.hash, user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); });
    console.log(`Temporary password; share securely and change after sign-in: ${password}`);
  }
} finally { db.close(); }
