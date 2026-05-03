const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // منع انقطاع connections مع Supabase Transaction Pooler
  max: 10,
  idleTimeoutMillis: 60000,        // 1 دقيقة قبل تجاهل connection خامل
  connectionTimeoutMillis: 10000,  // 10 ثوانٍ للاتصال قبل الفشل
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on('connect', () => console.log('✅ Connected to PostgreSQL'));
pool.on('error', (err) => {
  console.error('❌ DB pool error:', err.message);
  // لا نوقف السيرفر — Pool بيتعافى تلقائياً
});

module.exports = pool;
