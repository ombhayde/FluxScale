import pg from 'pg';

export const workloadPaths = { '/api/db/read': 'read', '/api/db/write': 'write', '/api/db/join': 'join', '/api/cpu': 'cpu' };

export function installDatabaseWorkloads(app, instanceId) {
  const pool = process.env.FLUXSCALE_DEMO_DATABASE_URL ? new pg.Pool({ connectionString: process.env.FLUXSCALE_DEMO_DATABASE_URL, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 3000 }) : null;
  pool?.on('error', () => console.error('Demo database connection failed'));
  for (const [path, sql, method] of [
    ['/api/db/read', 'SELECT id,name,price_cents FROM products WHERE id BETWEEN $1 AND $1+19 ORDER BY id', 'get'],
    ['/api/db/write', 'UPDATE benchmark_counters SET value=value+1 WHERE id=$1 RETURNING value', 'post'],
    ['/api/db/join', `SELECT c.region,cat.name,SUM(i.quantity*p.price_cents)::bigint AS total_cents
      FROM customers c JOIN orders o ON o.customer_id=c.id
      JOIN order_items i ON i.order_id=o.id JOIN products p ON p.id=i.product_id
      JOIN categories cat ON cat.id=p.category_id
      WHERE c.id BETWEEN $1 AND $1+99 GROUP BY c.region,cat.name ORDER BY total_cents DESC LIMIT 20`, 'get'],
  ]) {
    app[method](path, async (request, response) => {
      if (!pool) return response.status(503).json({ error: 'demo_database_not_configured' });
      const id = Math.max(1, Math.min(900, Number.parseInt(String(request.query.id ?? '1'), 10) || 1));
      try {
        const result = await pool.query(sql, [id]);
        response.json({ ok: true, workload: workloadPaths[path], rows: result.rowCount, value: method === 'post' ? Number(result.rows[0].value) : undefined, instance_id: instanceId });
      } catch {
        response.status(503).json({ error: 'demo_database_operation_failed', instance_id: instanceId });
      }
    });
  }
  return async () => pool?.end();
}
