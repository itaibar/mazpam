import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JSON_PATH = path.join(__dirname, 'mazpam.json')

let pool = null
const usePostgres = !!process.env.DATABASE_URL

// Try to import pg only if DATABASE_URL is set
if (usePostgres) {
  const pg = await import('pg')
  pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })
}

// JSON file helpers
function loadJSON() {
  if (fs.existsSync(JSON_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'))
    } catch (e) { /* ignore */ }
  }
  return { tickets: [], people: ['איתי בר', 'אורי כוחיי', 'ליאור עגמי'] }
}

function saveJSON(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2))
}

// Unified DB interface
const db = {
  async init() {
    if (usePostgres) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          department TEXT NOT NULL,
          environment TEXT NOT NULL,
          equipment_type TEXT NOT NULL,
          fault_type TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          subject TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'פתוח',
          tech_on_call TEXT DEFAULT '',
          assignee TEXT DEFAULT '',
          notes TEXT DEFAULT '[]',
          close_reason TEXT DEFAULT '',
          closed_at TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS people (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE
        )
      `)
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM people')
      if (parseInt(rows[0].count) === 0) {
        await pool.query("INSERT INTO people (name) VALUES ('איתי בר'), ('אורי כוחיי'), ('ליאור עגמי') ON CONFLICT DO NOTHING")
      }
      // Add missing columns
      try { await pool.query("ALTER TABLE tickets ADD COLUMN fault_type TEXT DEFAULT ''") } catch(e) { /* already exists */ }
      try { await pool.query("ALTER TABLE tickets ADD COLUMN close_reason TEXT DEFAULT ''") } catch(e) { /* already exists */ }
      try { await pool.query("ALTER TABLE tickets ADD COLUMN closed_at TEXT DEFAULT ''") } catch(e) { /* already exists */ }

      // Migrate UUIDs
      const { rows: uuidRows } = await pool.query("SELECT id FROM tickets WHERE LENGTH(id) > 5 ORDER BY created_at ASC")
      if (uuidRows.length > 0) {
        const { rows: maxRows } = await pool.query("SELECT id FROM tickets WHERE LENGTH(id) <= 5 ORDER BY id DESC LIMIT 1")
        let nextNum = maxRows.length > 0 ? parseInt(maxRows[0].id) + 1 : 1
        for (const row of uuidRows) {
          const newId = String(nextNum).padStart(5, '0')
          await pool.query('UPDATE tickets SET id = $1 WHERE id = $2', [newId, row.id])
          nextNum++
        }
        if (uuidRows.length > 0) console.log(`✅ Migrated ${uuidRows.length} ticket IDs`)
      }
      console.log('✅ Database initialized (PostgreSQL)')
    } else {
      const data = loadJSON()
      if (!data.tickets) data.tickets = []
      if (!data.people) data.people = ['איתי בר', 'אורי כוחיי', 'ליאור עגמי']
      // Migrate UUIDs
      let changed = false
      const uuids = data.tickets.filter(t => t.id.length > 5).sort((a, b) => a.createdAt > b.createdAt ? 1 : -1)
      if (uuids.length > 0) {
        const maxExisting = data.tickets.filter(t => t.id.length <= 5).map(t => parseInt(t.id)).sort((a, b) => b - a)
        let nextNum = maxExisting.length > 0 ? maxExisting[0] + 1 : 1
        for (const t of uuids) {
          t.id = String(nextNum).padStart(5, '0')
          nextNum++
          changed = true
        }
      }
      if (changed) saveJSON(data)
      console.log('✅ Database initialized (JSON file)')
    }
  },

  async generateId() {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) as max_id FROM tickets')
      return String(parseInt(rows[0].max_id) + 1).padStart(5, '0')
    } else {
      const data = loadJSON()
      const maxId = data.tickets.reduce((max, t) => Math.max(max, parseInt(t.id) || 0), 0)
      return String(maxId + 1).padStart(5, '0')
    }
  },

  // Tickets
  async getAllTickets() {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC')
      return rows.map(rowToTicket)
    } else {
      return loadJSON().tickets.map(t => ({ ...t, notes: typeof t.notes === 'string' ? JSON.parse(t.notes) : (t.notes || []) }))
    }
  },

  async getTicket(id) {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id])
      return rows.length > 0 ? rowToTicket(rows[0]) : null
    } else {
      const t = loadJSON().tickets.find(t => t.id === id)
      if (!t) return null
      return { ...t, notes: typeof t.notes === 'string' ? JSON.parse(t.notes) : (t.notes || []) }
    }
  },

  async createTicket(ticket) {
    if (usePostgres) {
      await pool.query(
        `INSERT INTO tickets (id, name, department, environment, equipment_type, fault_type, phone, subject, description, status, tech_on_call, assignee, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [ticket.id, ticket.name, ticket.department, ticket.environment, ticket.equipmentType, ticket.faultType, ticket.phone, ticket.subject, ticket.description, ticket.status, ticket.techOnCall, ticket.assignee, JSON.stringify(ticket.notes), ticket.createdAt, ticket.updatedAt]
      )
    } else {
      const data = loadJSON()
      data.tickets.push({
        ...ticket,
        notes: JSON.stringify(ticket.notes)
      })
      saveJSON(data)
    }
  },

  async updateTicket(id, updates) {
    if (usePostgres) {
      await pool.query(
        'UPDATE tickets SET status=$1, tech_on_call=$2, assignee=$3, notes=$4, close_reason=$5, closed_at=$6, updated_at=$7 WHERE id=$8',
        [updates.status, updates.techOnCall, updates.assignee, JSON.stringify(updates.notes), updates.closeReason || '', updates.closedAt || '', updates.updatedAt, id]
      )
    } else {
      const data = loadJSON()
      const index = data.tickets.findIndex(t => t.id === id)
      if (index !== -1) {
        data.tickets[index].status = updates.status
        data.tickets[index].techOnCall = updates.techOnCall
        data.tickets[index].assignee = updates.assignee
        data.tickets[index].notes = JSON.stringify(updates.notes)
        data.tickets[index].closeReason = updates.closeReason || ''
        data.tickets[index].closedAt = updates.closedAt || ''
        data.tickets[index].updatedAt = updates.updatedAt
        saveJSON(data)
      }
    }
  },

  async deleteTicket(id) {
    if (usePostgres) {
      await pool.query('DELETE FROM tickets WHERE id = $1', [id])
    } else {
      const data = loadJSON()
      data.tickets = data.tickets.filter(t => t.id !== id)
      saveJSON(data)
    }
  },

  // People
  async getPeople() {
    if (usePostgres) {
      const { rows } = await pool.query('SELECT name FROM people ORDER BY id')
      return rows.map(r => r.name)
    } else {
      return loadJSON().people || []
    }
  },

  async addPerson(name) {
    if (usePostgres) {
      await pool.query('INSERT INTO people (name) VALUES ($1)', [name])
    } else {
      const data = loadJSON()
      if (data.people.includes(name)) throw new Error('exists')
      data.people.push(name)
      saveJSON(data)
    }
  },

  async removePerson(name) {
    if (usePostgres) {
      const result = await pool.query('DELETE FROM people WHERE name = $1', [name])
      return result.rowCount > 0
    } else {
      const data = loadJSON()
      const index = data.people.indexOf(name)
      if (index === -1) return false
      data.people.splice(index, 1)
      saveJSON(data)
      return true
    }
  }
}

function rowToTicket(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    environment: row.environment,
    equipmentType: row.equipment_type,
    faultType: row.fault_type || '',
    closeReason: row.close_reason || '',
    closedAt: row.closed_at || '',
    phone: row.phone || '',
    subject: row.subject,
    description: row.description,
    status: row.status,
    techOnCall: row.tech_on_call || '',
    assignee: row.assignee || '',
    notes: row.notes ? JSON.parse(row.notes) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export default db
