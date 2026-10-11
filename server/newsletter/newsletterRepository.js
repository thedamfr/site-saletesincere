import { randomUUID } from 'node:crypto'

export function createNewsletterRepository(database) {
  const query = (...args) => {
    if (!database?.query) throw new Error('newsletter_journal_unavailable')
    return database.query(...args)
  }
  return {
    async register(email, listId) {
      const { rows } = await query(`
        INSERT INTO newsletter_requests (id, email, list_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (email, list_id) DO UPDATE SET email = EXCLUDED.email
        RETURNING *`, [randomUUID(), email, listId])
      return rows[0]
    },
    async get(id) {
      const { rows } = await query('SELECT * FROM newsletter_requests WHERE id = $1', [id])
      return rows[0]
    },
    async claim(id, phase) {
      const { rows } = await query(`
        WITH claimed AS (
          UPDATE newsletter_requests
          SET state = 'sending', phase = $2, attempted_at = clock_timestamp(),
              updated_at = clock_timestamp(), next_attempt_at = clock_timestamp() + interval '15 seconds'
          WHERE id = $1 AND state = 'ready'
          RETURNING *
        ), recorded AS (
          INSERT INTO newsletter_attempts (id, request_id, phase, attempted_at)
          SELECT $3::uuid, id, phase, attempted_at FROM claimed
          RETURNING request_id
        )
        SELECT claimed.* FROM claimed JOIN recorded ON recorded.request_id = claimed.id`, [id, phase, randomUUID()])
      return rows[0] || null
    },
    async transition(id, state, code, expectedStates = ['ready', 'sending', 'uncertain']) {
      const { rows } = await query(`
        UPDATE newsletter_requests
        SET state = $2, last_error_code = $3, updated_at = clock_timestamp(),
            next_attempt_at = clock_timestamp() + interval '30 seconds'
        WHERE id = $1 AND state = ANY($4::text[])
        RETURNING *`, [id, state, code, expectedStates])
      if (rows[0]) return rows[0]
      const current = await query('SELECT * FROM newsletter_requests WHERE id = $1', [id])
      return current.rows[0]
    },
    async due(limit = 20, listId = null) {
      const { rows } = await query(`
        SELECT * FROM newsletter_requests
        WHERE state IN ('ready', 'sending', 'uncertain') AND next_attempt_at <= clock_timestamp()
          AND ($2::bigint IS NULL OR list_id = $2)
        ORDER BY next_attempt_at, created_at
        LIMIT $1`, [limit, listId])
      return rows
    }
  }
}
