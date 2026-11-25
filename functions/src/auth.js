/**
 * Shared admin-allowlist check used by every callable function.
 * Firestore rules already block non-admins from reading/writing drafts
 * directly, but callable Cloud Functions run with admin privileges, so they
 * must re-check the allowlist themselves rather than relying on rules alone.
 */

const { HttpsError } = require('firebase-functions/v2/https');

async function requireAdmin(db, context) {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อนใช้งานฟังก์ชันนี้');
  }
  const uid = context.auth.uid;
  const snap = await db.collection('admin_users').doc(uid).get();
  if (!snap.exists || snap.data()?.allowed !== true) {
    throw new HttpsError(
      'permission-denied',
      'บัญชีนี้ไม่ได้รับอนุญาตให้เข้าถึงระบบ Admin Import — ติดต่อผู้ดูแลระบบเพื่อเพิ่มสิทธิ์ใน admin_users'
    );
  }
  return uid;
}

module.exports = { requireAdmin };
