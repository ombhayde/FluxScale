import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const passwordHash = async (password, salt = token()) => ({ salt, hash: (await promisify(scrypt)(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })).toString('hex') });
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1].includes(version)) { db.close(); throw Error('Unsupported connected database schema; restore a compatible backup'); }
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, service TEXT NOT NULL, policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, project_id TEXT UNIQUE NOT NULL REFERENCES projects(id), credential TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, snapshot TEXT, applied_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT, event TEXT NOT NULL, at INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  return db;
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
